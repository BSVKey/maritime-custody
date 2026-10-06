// Build a container's custody package the way it happens in practice: each party signs its own
// records with its own key as the box moves. Here one function plays every party so the whole
// flow can be run and tested in one place.
//
// route:    [{ party, kp, at, seal, condition, note? }]  receiving parties in order; the first is
//           the shipper stuffing and sealing the box
// legs:     [{ custodian, loggerId, from, to }]          reefer logger windows each holder attests to
// logs:     Map loggerId -> samples
// contacts: [{ at, aboard: [containerId...] }]           the vessel's satellite contacts
import { handoff, leg, voyage, outturn, commitSet, memberProof, cargoLine } from "./records.mjs";
import { windowOf, fingerprint, analyse } from "./logger.mjs";
import { verifyContainer } from "./verify.mjs";

export function buildContainer({ containerId, spec, cargo, route, legs = [], logs = new Map(), vessel, contacts = [], voyageId }) {
  const cargo_ = commitSet(cargo.map(cargoLine));
  const keyOf = new Map(route.map((r) => [r.party, r.kp]));
  const handoffs = [];
  route.forEach((r, i) => handoffs.push(handoff(r.kp, {
    containerId, from: i === 0 ? "origin" : route[i - 1].party, to: r.party, at: r.at, seal: r.seal, condition: r.condition, note: r.note ?? null,
    cargoRoot: cargo_.root, cargoCount: cargo_.count, prev: i === 0 ? null : handoffs[i - 1].claimId,
  })));
  const legRecords = legs.map((l) => {
    const win = windowOf(logs.get(l.loggerId), l.from, l.to);
    return leg(keyOf.get(l.custodian), { containerId, custodian: l.custodian, loggerId: l.loggerId, from: l.from, to: l.to, spec, fingerprint: fingerprint(win), analysis: analyse(win, { ...spec, from: l.from, to: l.to }) });
  });
  const records = [], proofs = [];
  contacts.forEach((c, i) => {
    const aboard = commitSet(c.aboard);
    records.push(voyage(keyOf.get(vessel), { vessel, voyageId, seq: i, contactAt: c.at, aboardRoot: aboard.root, aboardCount: aboard.count, prev: i === 0 ? null : records[i - 1].claimId }));
    proofs.push(memberProof(aboard, containerId));
  });
  const pkg = { containerId, spec, handoffs, legs: legRecords, voyage: { records, proofs } };

  // The consignee runs the same verification before signing its outturn.
  const pubs = Object.fromEntries(route.map((r) => [r.party, r.kp.pub]));
  const pre = verifyContainer(pkg, { partyPubs: pubs, logs });
  const last = route.at(-1);
  pkg.outturn = outturn(last.kp, { containerId, by: last.party, at: last.at, decision: pre.expected, findings: { liable: pre.liable, types: [...new Set(pre.findings.map((f) => f.type))].sort() } });
  return { package: pkg, cargo: cargo_ };
}
