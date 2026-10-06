import test from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../lib/keys.mjs";
import { signRecord, contentOf } from "../lib/record.mjs";
import { buildContainer } from "../src/container.mjs";
import { verifyContainer } from "../src/verify.mjs";
import { commitSet, memberProof, isMember, cargoLine } from "../src/records.mjs";

const MIN = 60000, H = 60 * MIN, T0 = Date.parse("2026-10-01T00:00:00Z");
const spec = { minC: 0, maxC: 4, budgetMinutes: 60, intervalMs: 15 * MIN, maxContactGapMs: 12 * H };
const series = (from, to, temp, skip = () => false) => { const s = []; for (let t = from; t <= to; t += 15 * MIN) if (!skip(t)) s.push([t, temp(t)]); return s; };
const cargo = [{ line: 1, description: "frozen fish", packages: 800, grossKg: 21000 }, { line: 2, description: "frozen squid", packages: 200, grossKg: 4800 }];

function box({ warmMin = 0, damagedAt = null, sealAt = null, contactGap = false, dropFrom = null } = {}) {
  const names = ["shipper", "terminal-a", "vessel", "terminal-b", "consignee"];
  const times = [T0, T0 + 4 * H, T0 + 8 * H, T0 + 56 * H, T0 + 64 * H];
  const route = names.map((party, i) => ({ party, kp: genKeypair(), at: times[i], seal: sealAt !== null && i >= sealAt ? "S-2" : "S-1", condition: damagedAt !== null && i >= damagedAt ? "damaged" : "sound" }));
  const logs = new Map([["R1", series(T0, times[4], (t) => (t >= T0 + 58 * H && t < T0 + 58 * H + warmMin * MIN ? 7 : 2))]]);
  const legs = names.slice(0, -1).map((c, i) => ({ custodian: c, loggerId: "R1", from: times[i], to: times[i + 1] }));
  const contacts = [];
  for (let t = times[2] + 6 * H; t < times[3]; t += 6 * H) if (!(contactGap && t > T0 + 20 * H && t < T0 + 40 * H)) contacts.push({ at: t, aboard: ["BOX1", "BOX2", ...(dropFrom !== null && t > dropFrom ? [] : ["DEMU0000001"])] });
  const built = buildContainer({ containerId: "DEMU0000001", spec, cargo, route, legs, logs, vessel: "vessel", contacts, voyageId: "V1" });
  return { ...built, route, logs, pins: Object.fromEntries(route.map((r) => [r.party, r.kp.pub])) };
}
const check = (b, pkg = b.package, logs = b.logs) => verifyContainer(pkg, { partyPubs: b.pins, logs });

test("a clean voyage verifies and is accepted", () => {
  const v = check(box());
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.decision, "accept");
  assert.deepEqual(v.liable, []);
});

test("an excursion within budget is recorded without fault; over budget it is a claim", () => {
  const small = check(box({ warmMin: 30 }));
  assert.equal(small.decision, "accept");
  assert.equal(small.findings.find((f) => f.type === "excursion").fault, false);
  const big = check(box({ warmMin: 90 }));
  assert.equal(big.ok, true, JSON.stringify(big.problems));
  assert.equal(big.decision, "claim");
  assert.deepEqual(big.liable, ["terminal-b"]);
  assert.deepEqual(big.attributedMinutes, { "terminal-b": 90 });
});

test("damage and seal changes are attributed to the previous holder", () => {
  const d = check(box({ damagedAt: 3 }));
  assert.deepEqual(d.findings.filter((f) => f.type === "damage_found").map((f) => f.party), ["vessel"]);
  const s = check(box({ sealAt: 2 }));
  assert.deepEqual(s.findings.filter((f) => f.type === "seal_changed").map((f) => f.party), ["terminal-a"]);
  assert.equal(s.decision, "claim");
});

test("vessel contact blackouts are reported without fault; a box missing from a report is a fault", () => {
  const g = check(box({ contactGap: true }));
  assert.equal(g.decision, "accept");
  assert.ok(g.findings.some((f) => f.type === "contact_blackout" && !f.fault));
  const m = check(box({ dropFrom: T0 + 30 * H }));
  assert.ok(m.findings.some((f) => f.type === "missing_from_manifest" && f.party === "vessel"));
  assert.deepEqual(m.liable, ["vessel"]);
});

test("withholding or falsifying a reefer leg does not move the loss", () => {
  const b = box({ warmMin: 90 });
  const run = (mutate) => { const p = structuredClone(b.package); const logs = new Map(b.logs); mutate(p, logs); return check(b, p, logs); };
  const withheld = run((p) => p.legs.splice(3, 1));
  assert.equal(withheld.ok, true, JSON.stringify(withheld.problems));
  assert.deepEqual(withheld.liable, ["terminal-b"]);
  const edited = run((p, logs) => logs.set("R1", logs.get("R1").filter(([, c]) => c <= 4)));
  assert.ok(edited.problems.some((x) => x.reason === "logger_data_does_not_match_leg"));
  assert.deepEqual(edited.liable, ["terminal-b"]);
});

test("forged, rewritten or inconsistent records are caught", () => {
  const b = box({ warmMin: 90 });
  const run = (mutate) => { const p = structuredClone(b.package); mutate(p); return check(b, p).problems.map((x) => x.reason); };
  assert.ok(run((p) => { p.voyage.records[2] = signRecord(b.route[2].kp, { ...contentOf(p.voyage.records[2]), seq: 9 }); }).includes("voyage_chain_break"));
  assert.ok(run((p) => { p.handoffs[3] = signRecord(b.route[3].kp, { ...contentOf(p.handoffs[3]), cargoCount: 1 }); }).includes("cargo_changed_in_transit"));
  assert.ok(run((p) => { p.outturn = signRecord(genKeypair(), contentOf(p.outturn)); }).includes("signer_not_pinned_party_key"));
  assert.ok(run((p) => { p.outturn = signRecord(b.route[4].kp, { ...contentOf(p.outturn), decision: "accept" }); }).includes("outturn_decision_inconsistent"));
  assert.ok(run((p) => { p.handoffs[1].seal = "S-9"; }).includes("claimId_mismatch"));
});

test("membership proofs: a packing-list line and a box aboard", () => {
  const c = commitSet(cargo.map(cargoLine));
  assert.equal(isMember(c.root, c.count, cargoLine(cargo[1]), memberProof(c, cargoLine(cargo[1]))), true);
  assert.equal(isMember(c.root, c.count, cargoLine({ ...cargo[1], packages: 201 }), memberProof(c, cargoLine(cargo[1]))), false);
});
