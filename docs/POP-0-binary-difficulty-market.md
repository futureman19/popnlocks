# POP-0: Binary Difficulty Markets

**popnlocks** — pop nLocks. The chain attests to its own vital signs; the winner pops the lock.

**Status: DRAFT — core primitive + chunked settlement ladder PoC-verified; mainnet end-to-end run executed 2026-11-06.**
Validated (2026-11-05, sCrypt 1.4.5 local VM): in-script verification of 17 real BSV
mainnet headers (anchor 830000) — linkage, sha256d-vs-bits PoW, bits2target expansion,
endpoint strike comparison. Settlement runs as a stateful ladder (4 cranks × 4 headers
in test geometry; production: chunks of 144): continuation outputs carry
tipHash/headersSeen/endpointTarget, final crank pays winner + bounty. Negative tests
green: tampered mid-ladder header, wrong-winner payout builder, skip-ahead linkage
break. 5/5 tests green.

**Mainnet evidence (2026-11-06, retro market on window 830001–830016, strike = real
endpoint target, YES paid 900 sats + 100 sat crank bounty, all in-covenant):**
deploy `ca36664a82e3b973b9307e2fc60f5e12fcb5b62ce2874257c4c25e10a28145ea` →
cranks `9d241d08…820b132355`, `03c29d96…a658fad2`, `d87e2ce8…c3ccc5df55` →
settle `92c3d27c1e258c751f14de99b57bc77302fd324df3748b15be4157ad2f54b3d8`.
All five mined in block **974267** (status via `arc.gorillapool.io/v1/tx/<txid>`).
Ops notes: scrypt-ts default fee (1 sat/KB) is miner-invisible — use ≥100 sat/KB;
broadcast via ARC (arc.gorillapool.io/v1/tx) rather than WOC; expect
`too-long-mempool-chain` beyond ~3 unconfirmed links — resume from the tip UTXO
(`scripts/resume.ts`).

Pending: fee/bounty calibration for production geometry (W=2016+M).

## 1. Concept

A binary market on BSV network difficulty, settled by the chain itself.

> "Will consensus difficulty be at or above strike **K** at the end of the market window?"

- YES and NO sides lock collateral into a covenant at deployment.
- After the window closes, **anyone** settles by presenting the real block headers.
- The covenant verifies the header chain in-script (linkage + proof-of-work + difficulty-rule consistency) and pays the winner. No oracle, no reporter, no dispute window.

The chain attests to its own vital signs; forging settlement data requires performing the work being measured.

## 2. Market Definition

Markets are defined **relative to an anchor block**, never absolute height —
Bitcoin Script cannot read block heights.

| Parameter          | Meaning                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `anchorHash`       | Hash of a recent block at deployment (the market's origin)                                                              |
| `W`                | Window length in blocks: the market covers exactly the `W` headers immediately following the anchor. Tenor ≈ W × 10 min |
| `strikeTarget`     | Strike expressed as a 256-bit target (integer math only, no division in-script)                                         |
| `M`                | Confirmation depth: headers required beyond the window for fork resistance                                              |
| `bounty`           | Satoshis carved from the pot for whoever cranks settlement                                                              |
| `yesPKH` / `noPKH` | Winner payout destinations, fixed at funding                                                                            |

**Primary instrument: difficulty-at-endpoint.** Settlement reads the `bits` field of the
final window header and compares `target(bits_W)` against `strikeTarget`.
Endpoint difficulty is a cleaner hedge than a window average (miners hedge the
difficulty level, and BSV's per-block DAA moves smoothly, so endpoint ≈ window character).

_Upgrade path (V2):_ true average-difficulty payoff via per-header division over the
window sum. Deferred — bigint division × W per chunk bloats script for marginal
instrument improvement.

## 3. Covenant

### 3.1 Funding (atomic)

One transaction: YES input + NO input → single covenant output holding the pot.
No unfunded state can exist, so no cancel/refund path is needed. Price discovery
(how the pot splits between YES and NO) happens off-chain between counterparties;
the covenant only records `yesPKH`, `noPKH`, and enforces total = pot.

### 3.2 State fields

```
anchorHash      32B   immutable
strikeTarget    32B   immutable
W, M            int   immutable
bounty          int   immutable
yesPKH, noPKH   20B   immutable
--- mutable (settlement ladder) ---
tipHash         32B   // last verified header hash; starts = anchorHash
headersSeen     int   // count of verified headers so far
phase           int   // OPEN -> SETTLED
```

### 3.3 Methods

**`settle(headers[])`** — anyone-callable, repeatable until `headersSeen == W + M`.

No loops exist in Bitcoin Script, so header verification runs in **chunks**
(recommended chunk = 144 headers ≈ one day; each call's unlocking data ≈ 11.5 KB).
Each call:

1. Verify `headers[0].prevHash == tipHash` (linkage from last verified state).
2. For each header in the chunk:
   - `hash256d(header) < target(bits)` — real PoW under its own claimed difficulty.
   - `bits` evolution is DAA-consistent with the previous header (see §4).
3. Update `tipHash`, `headersSeen`; emit continuation output (OP_PUSH_TX covenant).
4. When `headersSeen == W + M`:
   - Read `bits` of the header at position `W` (the endpoint — carried in state once passed).
   - `target(bits_W) <= strikeTarget` → YES wins, else NO wins.
   - Outputs: winner receives `pot − bounty − fees`; cranker receives `bounty` to an address of their choice.

The crank is agnostic — the contract computes the winner; the bounty only buys speed.
Liveness is guaranteed by the winner's own incentive to settle.

## 4. The DAA-Consistency Check — RESOLVED (Lite tier, PoC-verified)

**Finding (2026-11-05):** BSV's consensus DAA is **cw-144** (`GetNextCashWorkRequired`
in bitcoin-sv `pow.cpp`): each block's `bits` is recomputed from the chainwork and
clamped elapsed time over the _trailing 144 blocks_ (median-of-3 endpoints).
Full in-script replication is therefore O(W×144) data — every header's check needs its
own 144-block context. That kills the Full tier for a ladder design regardless of
script budget.

**V1 ships Lite, now implemented and tested:**

- **Per-header drift bound:** each header's target within ±5% of its predecessor's
  (natural cw-144 drift measured at ≤1.9%/block on the golden mainnet window).
- **Anchor-relative difficulty floor:** no header's target may exceed 8× the anchor's,
  so faking the window costs ≥ ~1/8 of real mainnet work per block — the §5 pot cap
  prices the residual band.
- Drift base (`prevTarget`) is carried in covenant state across chunks — no free reset
  at chunk boundaries.

Test evidence: synthetic chains ground at trivial difficulty — a rule-abiding chain
passes (control), a ×3 drift jump is rejected on the drift bound, a ×3855 floor breach
is rejected on the floor assert. 8/8 green.

**Residual honesty:** an attacker can still drift difficulty ±5%/block _within_ the
floor over many blocks; the defense is economic (§5 sizing) plus counterparties
choosing strikes away from the floor band. A V2 challenge window (§5) closes this
further by letting heavier chains contest settlement.

## 5. Fork/Manipulation Economics

The attack: privately mine an alternative `W + M` headers from the anchor to fake
the endpoint difficulty. Cost ≈ `(W + M) ×` per-block mining cost at mainnet
difficulty, plus orphan risk — independent of the pot.

**Sizing rule:** `pot ≤ 1–5% × (W + M) × blockCost`.
Rule-of-thumb block cost ≈ block subsidy value in equilibrium (3.125 BSV + fees),
so a W=144 (1-day) market with M=10 supports pots comfortably in the low thousands
of dollars; W=2016 (~2 weeks) supports much more. Publish the exact assumed
`blockCost` per market in its descriptor.

A **challenge window** (alternative heavier chain may contest settlement within C
blocks) is a V2 upgrade; V1 relies on confirmation depth + pot cap.

## 6. Edge Cases

- **Reorg through the window:** covered by §5 — settlement only final after M extra
  verified headers; deeper reorgs than M are assumed economically irrational.
- **No settlement:** impossible in equilibrium — the winner always profits by cranking.
- **Anchor staleness:** anchor must be buried ≥ 6 blocks at funding time so both
  parties agree it's mainnet.
- **Retro markets:** the design also settles _historical_ windows instantly (anchor in
  the past). Economically pointless, but a free correctness demo and test-vector source.

## 7. Build & Test Plan

1. sCrypt project (`scrypt-cli project --state`), local DummyProvider — the local VM
   executes real covenant semantics (OP_PUSH_TX, hashOutputs) with no node.
2. Reference vectors: real mainnet header runs (a historical 144+10 chain segment),
   frozen as golden test vectors — settlement outcome known in advance.
3. Negative tests: wrong linkage, PoW below claimed bits, bits jump beyond DAA bound,
   forged continuation output, double-settlement.
4. Testnet market end-to-end: fund → wait → permissionless settle by a third party.

**Field names to avoid:** `state` is a reserved sCrypt compiler keyword (use `phase`).

## 8. Open Items

- [ ] Confirm exact BSV DAA formula + constants against node source.
- [ ] Script-size measurement for one 144-header chunk under full DAA check (decides Full vs Lite for V1).
- [ ] Fee/bounty calibration so settlement is profitable at 1-conf urgency.
- [ ] Decide whether `yesPKH`/`noPKH` may be updated pre-settlement (transferable positions = order book; V2).
