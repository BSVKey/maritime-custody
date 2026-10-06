// Verify a container's custody package against pinned party keys, the raw reefer logger data
// and the vessel's contact reports.
//
// package: { containerId, spec, handoffs, legs, voyage: { records, proofs }, outturn }
// partyPubs: { partyId: publicKey }   the verifier's own pinned keys (the vessel is a party)
// logs: Map loggerId -> samples        reefer logger exports the verifier holds
//
// Findings are tied to the party holding the container when they happened:
//   seal_changed         seal at a handoff differs from the previous one: the previous holder
//   damage_found         condition first reported damaged: the previous holder
//   excursion            reefer out of range (from the raw logger data): the holder at the time
//   logger_gap           reefer logger silent (unknown temperature): the holder at the time
//   unaccounted_custody  reefer custody time with no verified leg (counts as unknown
//                        temperature against the budget): that holder
//   missing_from_manifest the vessel's signed contact report did not include the container
//   contact_blackout     no vessel contact for longer than spec.maxContactGapMs (informational)
// The consignee's outturn decision must follow from the findings: "claim" if any party is at
// fault, otherwise "accept". Over the reefer budget, attributedMinutes gives the minutes each
// party is at fault for: the factual basis for splitting a spoilage loss.
import { verifyRecord } from "../lib/record.mjs";
import { windowOf, fingerprint, analyse } from "./logger.mjs";
import { isMember } from "./records.mjs";

const canon = (x) => JSON.stringify(x);
const round1 = (x) => Math.round(x * 10) / 10;
const FAULT = new Set(["seal_changed", "damage_found", "excursion", "logger_gap", "unaccounted_custody", "missing_from_manifest"]);

export function verifyContainer(pkg, { partyPubs, logs }) {
  const problems = [];
  const bad = (reason, detail = {}) => problems.push({ reason, ...detail });
  const signedBy = (r, party) => {
    const v = verifyRecord(r);
    if (!v.ok) { bad(v.reason, { kind: r?.kind, claimId: r?.claimId }); return false; }
    if (!partyPubs[party]) { bad("party_not_pinned", { party }); return false; }
    if (v.signer !== partyPubs[party]) { bad("signer_not_pinned_party_key", { party, kind: r.kind }); return false; }
    if (r.containerId !== undefined && r.containerId !== pkg.containerId) { bad("wrong_container", { claimId: r.claimId }); return false; }
    return true;
  };
  const findings = [];
  const spec = pkg.spec || {};

  // 1. Handoff chain: receiver signs, each names the previous, one packing list throughout.
  const hs = pkg.handoffs || [];
  if (!hs.length) bad("no_handoffs");
  hs.forEach((h, i) => {
    signedBy(h, h.to);
    if (i === 0) { if (h.prev !== null) bad("first_handoff_has_prev"); return; }
    const p = hs[i - 1];
    if (h.prev !== p.claimId) bad("handoff_chain_break", { index: i });
    if (h.from !== p.to) bad("handoff_party_mismatch", { index: i });
    if (h.at < p.at) bad("handoff_time_regression", { index: i });
    if (h.cargoRoot !== hs[0].cargoRoot || h.cargoCount !== hs[0].cargoCount) bad("cargo_changed_in_transit", { index: i, at: h.to });
    if (h.seal !== p.seal) findings.push({ type: "seal_changed", party: p.to, at: h.at, was: p.seal, now: h.seal, reportedBy: h.to });
    if (h.condition === "damaged" && p.condition !== "damaged") findings.push({ type: "damage_found", party: p.to, at: h.at, note: h.note, reportedBy: h.to });
  });
  const windows = hs.slice(0, -1).map((h, i) => ({ party: h.to, from: h.at, to: hs[i + 1].at }));

  // 2. Reefer legs: signed by the holder, inside its window, matching the raw logger data.
  const reefer = spec.minC !== undefined;
  let excursionMinutes = 0, gapMinutes = 0, unaccountedMinutes = 0;
  const verified = [];
  for (const l of reefer ? pkg.legs || [] : []) {
    if (!signedBy(l, l.custodian)) continue;
    if (!windows.some((w) => w.party === l.custodian && l.from >= w.from && l.to <= w.to)) { bad("leg_outside_custody_window", { party: l.custodian }); continue; }
    const samples = logs.get(l.loggerId);
    if (!samples) { bad("logger_data_missing", { loggerId: l.loggerId }); continue; }
    const win = windowOf(samples, l.from, l.to);
    if (fingerprint(win) !== l.fingerprint) { bad("logger_data_does_not_match_leg", { party: l.custodian, loggerId: l.loggerId }); continue; }
    const again = analyse(win, { ...spec, from: l.from, to: l.to });
    if (canon(again) !== canon(l.analysis)) { bad("leg_analysis_misstated", { party: l.custodian }); continue; }
    verified.push(l);
    excursionMinutes += again.excursionMinutes;
    gapMinutes += again.gapMinutes;
    for (const e of again.excursions) findings.push({ type: "excursion", party: l.custodian, ...e });
    for (const g of again.gaps) findings.push({ type: "logger_gap", party: l.custodian, ...g });
  }
  // Custody time with no verified leg is unknown temperature for its whole length: a leg that
  // fails verification is no evidence at all, so withholding or falsifying one gains nothing.
  if (reefer) for (const w of windows) {
    const covered = verified.filter((l) => l.custodian === w.party).reduce((a, l) => a + (l.to - l.from), 0);
    const missing = w.to - w.from - covered;
    if (missing > 60000) {
      findings.push({ type: "unaccounted_custody", party: w.party, start: w.from, end: w.to, minutes: round1(missing / 60000) });
      unaccountedMinutes += missing / 60000;
    }
  }

  // 3. Vessel contact reports: chained, signed by the vessel, and listing this container at
  // every contact while the vessel held it.
  const vr = pkg.voyage?.records || [];
  const vproofs = pkg.voyage?.proofs || [];
  const vw = windows.find((w) => vr.length && w.party === vr[0].vessel);
  vr.forEach((c, i) => {
    if (!signedBy(c, c.vessel)) return;
    if (i > 0 && (c.prev !== vr[i - 1].claimId || c.seq !== vr[i - 1].seq + 1)) bad("voyage_chain_break", { seq: c.seq });
    if (vw && (c.contactAt < vw.from || c.contactAt > vw.to)) bad("contact_outside_vessel_custody", { seq: c.seq });
    if (!isMember(c.aboardRoot, c.aboardCount, pkg.containerId, vproofs[i])) findings.push({ type: "missing_from_manifest", party: c.vessel, at: c.contactAt, seq: c.seq });
  });
  if (vw && spec.maxContactGapMs) {
    const pts = [vw.from, ...vr.map((c) => c.contactAt), vw.to];
    for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > spec.maxContactGapMs) findings.push({ type: "contact_blackout", party: vw.party, start: pts[i - 1], end: pts[i], hours: round1((pts[i] - pts[i - 1]) / 3.6e6) });
  }

  // 4. Reefer budget: within budget, excursions and gaps are recorded but nobody is at fault.
  excursionMinutes = round1(excursionMinutes);
  gapMinutes = round1(gapMinutes);
  unaccountedMinutes = round1(unaccountedMinutes);
  const charged = round1(excursionMinutes + unaccountedMinutes + (spec.gapsCount === false ? 0 : gapMinutes));
  const overBudget = reefer && charged > spec.budgetMinutes;
  for (const f of findings) f.fault = FAULT.has(f.type) && (!["excursion", "logger_gap"].includes(f.type) || (overBudget && (f.type === "excursion" || spec.gapsCount !== false)));
  const liable = [...new Set(findings.filter((f) => f.fault).map((f) => f.party))].sort();

  // Reefer minutes each party is at fault for (excursions, counted gaps, unaccounted custody).
  const attributedMinutes = {};
  if (overBudget) for (const f of findings.filter((x) => x.fault && x.minutes !== undefined)) attributedMinutes[f.party] = round1((attributedMinutes[f.party] || 0) + f.minutes);

  // 5. Outturn: signed by the consignee; decision and liable parties must follow.
  const expected = liable.length ? "claim" : "accept";
  const o = pkg.outturn;
  if (!o) bad("no_outturn");
  else if (signedBy(o, hs.at(-1)?.to)) {
    if (o.decision !== expected) bad("outturn_decision_inconsistent", { stated: o.decision, expected });
    if (canon([...(o.findings?.liable || [])].sort()) !== canon(liable)) bad("outturn_liable_parties_misstated", { stated: o.findings?.liable, actual: liable });
  }

  return { ok: problems.length === 0, problems, decision: o?.decision ?? null, expected, liable, findings, excursionMinutes, gapMinutes, unaccountedMinutes, chargedMinutes: charged, budgetMinutes: spec.budgetMinutes, attributedMinutes };
}
