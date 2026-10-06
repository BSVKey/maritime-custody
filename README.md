# Maritime Custody

Verifiable chain of custody for shipping containers, port to port.

A container passes from shipper to trucker, terminal, vessel, terminal, trucker and
consignee. Every party that receives it signs what it received, the seal number and the
condition. Whoever holds a refrigerated container signs a fingerprint of the reefer
logger data for its time. The vessel signs one report per satellite contact covering
every box aboard. Anyone with the records and the logger export can later check where
along the route a loss happened, and which party held the container when it did.

```
npm test          # offline, zero dependencies
node demo.mjs     # a reefer container: grower -> trucker -> terminal -> vessel -> terminal -> trucker -> importer
```

## What the demo shows

A refrigerated container of chilled produce, 0 to 4 C with a 120-minute excursion budget.
The vessel reports at each satellite contact and loses contact for 30 hours mid-ocean. At
the destination terminal the reefer is left unplugged for 150 minutes; the destination
trucker's logger goes silent for 45.

```
Vessel contact reports: 43, each one signature over 1800 boxes

Verified from the raw reefer CSV and the vessel's reports: PASS
Excursions 150 min + logger gaps 45 min = 195 of 120 min allowed: outturn "claim"
  excursion         terminal-dest   150 min, peak 8.57 C
  logger_gap        trucker-dest    45 min
  contact_blackout  vessel-aurora   30 h without contact  (no fault)
Liable: terminal-dest, trucker-dest
Reefer minutes at fault: terminal-dest 150 min, trucker-dest 45 min

DEMU4001173 aboard at contact 10: true
Packing-list line 8 in this container: true

Tampering:
  terminal deletes its warm rows from the reefer export      caught
  terminal re-signs a clean leg for itself                   caught
  terminal withholds its leg entirely                        no gain: still liable
  vessel rewrites a contact report after the fact            caught
  terminal re-signs its handoff with a different seal        caught
  packing list swapped at the destination terminal           caught
  importer's outturn forged by another party                 caught
  outturn names only the trucker as liable                   caught
```

The vessel's 30 hours out of contact is recorded but is nobody's fault, because the
reefer log covers it. The unplugged reefer at the destination terminal is what turned the
box into a claim.

## Records

| Record | Signed by | Says |
|---|---|---|
| `maritime.handoff/1` | the receiving party | received this container from that party at this time, with this seal number, in this condition; one Merkle root over the packing list; names the previous handoff |
| `maritime.leg/1` | the party holding a reefer container | which logger, which time window, a fingerprint of exactly those samples, and what they show: range, excursions, gaps |
| `maritime.voyage/1` | the vessel, once per satellite contact | one Merkle root over every container aboard, chained to the previous contact |
| `maritime.outturn/1` | the consignee | what was found at destination, the decision (accept or claim) and the liable parties |

Any packing-list line, and any container aboard at a given contact, can be proven with a
short inclusion proof without revealing the rest. All records use canonical JSON, a
SHA-256 content id and an Ed25519 signature.

## Rules the verifier applies

- Every record verifies and is signed by the pinned key of the party it names. Keys come
  from the verifier, never from the records.
- Handoffs chain from origin to consignee, in time order, with one packing list
  throughout. A changed packing list is flagged.
- A seal that differs from the previous handoff's, or damage first reported at a handoff,
  is a finding against the party that held the container before it.
- Reefer legs must lie inside the holder's custody window and match the raw logger export
  exactly. Excursions and logger gaps go to the holder at the time.
- Reefer custody time with no verified leg counts as unknown temperature against the
  budget, so withholding or falsifying a leg gains nothing.
- Within budget, excursions and gaps are recorded without fault.
- The vessel's contact reports must chain and list the container at every contact while
  the vessel held it. Long gaps between contacts are reported, without fault.
- The consignee's outturn decision and liable parties must follow from the findings.

## Scope

The software records only what the parties choose to record. It does not replace bills of
lading, surveys or carrier systems. Sanctions and export rules still apply to cargoes and
routes.

## License

Apache License 2.0. Copyright 2026 Embryo Space Inc. (DBA BSVKey).
