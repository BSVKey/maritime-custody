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
import { randomBytes } from "node:crypto";
import { signRecord } from "../lib/record.mjs";
import { leafHash, buildTree, proof, verifyProof } from "../lib/merkle.mjs";

// Leaves are salted (salted-leaf/1): each item gets 16 random bytes, and leaves are ordered by
// their salted hash. Without the salt, the sibling hashes in one item's proof could be matched
// against guessed values to reveal the items next to it. The salt travels only in that item's
// own proof. saltOf(key) can be supplied for reproducible commitments.
export const LEAF_SCHEME = "salted-leaf/1";
const SALT_RE = /^[0-9a-f]{32}$/;
const randomSalt = () => randomBytes(16).toString("hex");
const saltedLeaf = (salt, s) => leafHash(Buffer.from(`${salt}|${s}`, "utf8"));
function commitSalted(keys, saltOf = randomSalt) {
  const entries = keys.map((key) => {
    const salt = saltOf(key);
    if (!SALT_RE.test(salt)) throw new Error("salt must be 32 lowercase hex characters");
    return { key, salt, leaf: saltedLeaf(salt, key) };
  }).sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0));
  const tree = buildTree(entries.map((e) => e.leaf));
  return { root: tree.root, count: entries.length, scheme: LEAF_SCHEME, keys: entries.map((e) => e.key), salts: entries.map((e) => e.salt), tree };
}
const saltedProof = (c, key) => { const i = c.keys.indexOf(key); return i < 0 ? null : { index: i, salt: c.salts[i], branch: proof(c.tree, i) }; };
const saltedMember = (root, count, key, p) => !!p && SALT_RE.test(p.salt) && p.index >= 0 && p.index < count && verifyProof(saltedLeaf(p.salt, key), p.branch, p.index, root);

// Commit a set of strings (packing-list lines, or container ids aboard) as a Merkle root.
export function commitSet(items, { saltOf } = {}) {
  const keys = [...new Set(items)];
  if (keys.length === 0) throw new Error("commitSet: empty set");
  return commitSalted(keys, saltOf);
}
export const memberProof = (commitment, item) => saltedProof(commitment, item);
export const isMember = (root, count, item, p) => saltedMember(root, count, item, p);

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
