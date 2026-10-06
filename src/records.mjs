// Signed records for a container's chain of custody, port to port.
//
//   maritime.handoff/1  signed by the RECEIVING party: "at this time I received this container
//                       from that party, with this seal number, in this condition". Each handoff
//                       names the previous one, forming a chain, and carries one commitment over
//                       the packing list.
//   maritime.leg/1      signed by the party holding a refrigerated container: the reefer logger,
//                       the window, a fingerprint of exactly those samples, and what they show
//                       (the pharma cold-chain engine).
//   maritime.voyage/1   signed by the vessel once per satellite contact: one Merkle root over
//                       every container aboard, chained to the previous contact. One signature
//                       covers thousands of boxes; any one box can be proven aboard.
//   maritime.outturn/1  signed by the consignee at destination: what was found, and whether the
//                       container is accepted or claimed.
import { signRecord } from "../lib/record.mjs";
import { leafHash, buildTree, proof, verifyProof } from "../lib/merkle.mjs";

const leaf = (s) => leafHash(Buffer.from(s, "utf8"));

// Commit a set of strings (packing-list lines, or container ids aboard) as a Merkle root.
export function commitSet(items) {
  const keys = [...new Set(items)].sort();
  if (keys.length === 0) throw new Error("commitSet: empty set");
  const tree = buildTree(keys.map(leaf));
  return { root: tree.root, count: keys.length, keys, tree };
}
export function memberProof(commitment, item) {
  const i = commitment.keys.indexOf(item);
  return i < 0 ? null : { index: i, branch: proof(commitment.tree, i) };
}
export const isMember = (root, count, item, p) => !!p && p.index >= 0 && p.index < count && verifyProof(leaf(item), p.branch, p.index, root);

// Packing-list line: one string per line so any line can be proven without the rest.
export const cargoLine = (l) => `${l.line}|${l.description}|${l.packages}|${l.grossKg}`;

export const handoff = (kp, { containerId, from, to, at, seal, condition, note = null, cargoRoot, cargoCount, prev = null }) =>
  signRecord(kp, { kind: "maritime.handoff/1", containerId, from, to, at, seal, condition, note, cargoRoot, cargoCount, prev });

export const leg = (kp, { containerId, custodian, loggerId, from, to, spec, fingerprint, analysis }) =>
  signRecord(kp, { kind: "maritime.leg/1", containerId, custodian, loggerId, from, to, spec, fingerprint, analysis });

export const voyage = (kp, { vessel, voyageId, seq, contactAt, aboardRoot, aboardCount, prev = null }) =>
  signRecord(kp, { kind: "maritime.voyage/1", vessel, voyageId, seq, contactAt, aboardRoot, aboardCount, prev });

export const outturn = (kp, { containerId, by, at, decision, findings }) =>
  signRecord(kp, { kind: "maritime.outturn/1", containerId, by, at, decision, findings });
