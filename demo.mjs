#!/usr/bin/env node
// A refrigerated container of chilled produce (0 to 4 C, 120-minute excursion budget) moving
// grower -> origin trucker -> origin terminal -> vessel -> destination terminal -> destination
// trucker -> importer. The vessel reports once per satellite contact, one signature over all
// 1,800 boxes aboard, and loses contact for 30 hours mid-ocean. At the destination terminal the
// reefer is left unplugged for 150 minutes; the destination trucker's leg has a 45-minute logger
// gap. The demo writes the reefer logger's CSV export, builds every party's signed records,
// verifies the whole package from the raw CSV, then shows tampering being caught.
//   node demo.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genKeypair } from "./lib/keys.mjs";
import { signRecord, contentOf } from "./lib/record.mjs";
import { parseLoggerCsv } from "./src/logger.mjs";
import { buildContainer } from "./src/container.mjs";
import { verifyContainer } from "./src/verify.mjs";
import { commitSet, memberProof, isMember, cargoLine } from "./src/records.mjs";

const MIN = 60000, H = 60 * MIN, D = 24 * H, T0 = Date.parse("2026-10-01T06:00:00Z");
const spec = { minC: 0, maxC: 4, budgetMinutes: 120, intervalMs: 15 * MIN, maxContactGapMs: 12 * H };
const at = (t) => new Date(t).toISOString().slice(5, 16).replace("T", " ");
const BOX = "DEMU4001173";

// Route times.
const t = { grower: T0, truckA: T0 + 6 * H, termA: T0 + 10 * H, vessel: T0 + 40 * H };
t.termB = t.vessel + 12 * D; t.truckB = t.termB + 20 * H; t.importer = t.truckB + 26 * H;
const unplug = [t.termB + 8 * H, t.termB + 8 * H + 150 * MIN];
const silent = [t.truckB + 10 * H, t.truckB + 10 * H + 45 * MIN];

// The container's own reefer controller logs every 15 minutes for the whole trip.
const rows = ["timestamp,temp_c"];
for (let x = T0; x <= t.importer; x += spec.intervalMs) {
  if (x > silent[0] && x < silent[1]) continue;
  const warm = x >= unplug[0] && x < unplug[1] ? 5.2 + (x - unplug[0]) / (40 * MIN) : null;
  rows.push(`${new Date(x).toISOString()},${(warm ?? 2 + 0.6 * Math.sin(x / 7.1e6)).toFixed(2)}`);
}
const dir = mkdtempSync(join(tmpdir(), "maritime-demo-"));
writeFileSync(join(dir, "reefer-DEMU4001173.csv"), rows.join("\n") + "\n");
const load = () => new Map([["reefer-DEMU4001173", parseLoggerCsv(readFileSync(join(dir, "reefer-DEMU4001173.csv"), "utf8")).samples]]);

try {
  const p = (party, at_, extra = {}) => ({ party, kp: genKeypair(), at: at_, seal: "SL-778201", condition: "sound", ...extra });
  const route = [p("grower", t.grower), p("trucker-origin", t.truckA), p("terminal-origin", t.termA), p("vessel-aurora", t.vessel), p("terminal-dest", t.termB), p("trucker-dest", t.truckB), p("importer", t.importer)];
  const legs = route.slice(0, -1).map((r, i) => ({ custodian: r.party, loggerId: "reefer-DEMU4001173", from: r.at, to: route[i + 1].at }));
  const cargo = Array.from({ length: 20 }, (_, i) => ({ line: i + 1, description: `chilled table grapes, pallet ${i + 1}`, packages: 96, grossKg: 1020 }));

  // 1,800 boxes aboard; the vessel reports every 6 hours, except a 30-hour blackout on day 5.
  const others = Array.from({ length: 1799 }, (_, i) => `DEMU${String(5000000 + i * 37).slice(0, 7)}`);
  const contacts = [];
  for (let x = t.vessel + 6 * H; x < t.termB; x += 6 * H) if (!(x > t.vessel + 5 * D && x < t.vessel + 5 * D + 30 * H)) contacts.push({ at: x, aboard: [BOX, ...others] });

  const { package: pkg, cargo: committed } = buildContainer({ containerId: BOX, spec, cargo, route, legs, logs: load(), vessel: "vessel-aurora", contacts, voyageId: "AUR-042E" });
  const pins = Object.fromEntries(route.map((r) => [r.party, r.kp.pub]));

  console.log(`Container ${BOX}: ${committed.count} packing-list lines, reefer ${spec.minC} to ${spec.maxC} C, budget ${spec.budgetMinutes} min`);
  console.log(`Route: ${route.map((r) => r.party).join(" -> ")}`);
  console.log(`Vessel contact reports: ${contacts.length}, each one signature over ${contacts[0].aboard.length} boxes\n`);
  const v = verifyContainer(pkg, { partyPubs: pins, logs: load() });
  console.log(`Verified from the raw reefer CSV and the vessel's reports: ${v.ok ? "PASS" : "FAIL " + JSON.stringify(v.problems)}`);
  console.log(`Excursions ${v.excursionMinutes} min + logger gaps ${v.gapMinutes} min = ${v.chargedMinutes} of ${v.budgetMinutes} min allowed: outturn "${v.decision}" (expected "${v.expected}")`);
  for (const f of v.findings) {
    const what = f.minutes !== undefined ? `${f.minutes} min${f.peakC !== undefined ? `, peak ${f.peakC} C` : ""}` : f.hours !== undefined ? `${f.hours} h without contact` : "";
    console.log(`  ${f.type.padEnd(17)} ${f.party.padEnd(15)} ${at(f.start ?? f.at)} UTC  ${what}${f.fault ? "" : "  (no fault)"}`);
  }
  console.log(`Liable: ${v.liable.join(", ")}`);
  console.log(`Reefer minutes at fault: ${Object.entries(v.attributedMinutes).map(([k, m]) => `${k} ${m} min`).join(", ")}`);

  const aboard = commitSet(contacts[10].aboard), c10 = pkg.voyage.records[10];
  console.log(`\n${BOX} aboard at contact ${c10.seq} (${at(c10.contactAt)}): ${isMember(c10.aboardRoot, c10.aboardCount, BOX, memberProof(aboard, BOX))}`);
  const line = cargoLine(cargo[7]);
  console.log(`Packing-list line 8 in this container: ${isMember(pkg.handoffs[0].cargoRoot, pkg.handoffs[0].cargoCount, line, memberProof(committed, line))}`);

  console.log("\nTampering:");
  const attempt = (label, mutate, expectOk = false) => {
    const q = structuredClone(pkg), logs = load();
    mutate(q, logs);
    const r = verifyContainer(q, { partyPubs: pins, logs });
    const verdict = r.ok ? (expectOk ? `no gain: ${r.liable.join(", ")} still liable` : "NOT CAUGHT") : "caught: " + [...new Set(r.problems.map((x) => x.reason))].join(", ");
    console.log(`  ${label.padEnd(58)} ${verdict}`);
  };
  const ti = route.findIndex((r) => r.party === "terminal-dest");
  attempt("terminal deletes its warm rows from the reefer export", (q, logs) => logs.set("reefer-DEMU4001173", logs.get("reefer-DEMU4001173").filter(([, c]) => c <= 4)), true);
  attempt("terminal re-signs a clean leg for itself", (q) => { q.legs[ti] = signRecord(route[ti].kp, { ...contentOf(q.legs[ti]), analysis: { ...q.legs[ti].analysis, excursions: [], excursionMinutes: 0 } }); }, true);
  attempt("terminal withholds its leg entirely", (q) => { q.legs.splice(ti, 1); }, true);
  attempt("vessel rewrites a contact report after the fact", (q) => { const c = q.voyage.records[3]; q.voyage.records[3] = signRecord(route[3].kp, { ...contentOf(c), contactAt: c.contactAt + H }); });
  attempt("terminal re-signs its handoff with a different seal", (q) => { q.handoffs[ti] = signRecord(route[ti].kp, { ...contentOf(q.handoffs[ti]), seal: "SL-990001" }); });
  attempt("packing list swapped at the destination terminal", (q) => { q.handoffs[ti] = signRecord(route[ti].kp, { ...contentOf(q.handoffs[ti]), cargoRoot: "00".repeat(32) }); });
  attempt("importer's outturn forged by another party", (q) => { q.outturn = signRecord(genKeypair(), contentOf(q.outturn)); });
  attempt("outturn names only the trucker as liable", (q) => { q.outturn = signRecord(route.at(-1).kp, { ...contentOf(q.outturn), findings: { ...q.outturn.findings, liable: ["trucker-dest"] } }); });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
