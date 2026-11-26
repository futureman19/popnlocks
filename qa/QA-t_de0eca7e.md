# Popnlocks offline quote & take-flow safety QA — t_de0eca7e

- Lane: qwen · Branch: wt/t_de0eca7e · HEAD: 40beff011cc6beef2407ba34a8606c1ba2fc85ac
  ("Connect read-only maker quotes with honest freshness states")
- Scope: bounded, read-only adversarial QA. Synthetic fixtures + local tests only.
  Disposable testnet keys, fake chain, file-backed ledger in temp dirs, loopback
  HTTP. No wallet/keys/funds, no live chain/provider calls, no broadcast/push/
  deploy/spend, no release claim. Product source left unchanged.

## Commands and results (exact)

1. `npx mocha --grep "QA adversarial"` → 21 passing / 0 failing (new suite).
2. `npx mocha` (full worktree suite, .mocharc spec ./tests/**/\*.test.ts) →
   **83 passing / 0 failing\*\* (6s). 11 test files in this worktree.
   NOTE: the "1526" figure cited in recent lane history belongs to a different
   branch state (S9 commit 2086f0c); this card worktree at 40beff0 carries 11
   test files / 83 tests. Reported count is the actual one here.
3. `python tests/board-browser.py` → **FAILED at first case** (see Finding 1).
4. `git checkout -- qa/evidence/` → restored snapshot-clock/newline drift the
   browser harness regeneration produced; `git status` clean except the new
   additive test + this report. No product file modified.

## Covered attack cases (all fail closed)

New additive suite: `tests/qaSafetyAdversarial.test.ts` (21 tests).

Quote schema (`src/offers/quoteSchema.ts`):

- Non-object roots (null/undefined/number/string/bool/array) rejected by
  parseQuote + isQuote=false.
- Wrong primitive types per field (quoteId/makerPKH/makerSide/makerStake/
  takerStake/expiryHeight).
- Malformed market subfields: fractional anchorHeight, uppercase/short
  anchorTipHex, negative anchorBits, non-canonical strikeTarget (0x-prefixed,
  leading zero), bounty 0 and bounty>=pot.
- Malformed identifiers: uppercase makerPKH, empty/over-128 quoteId.
- Out-of-range stakes: 0, -1, fractional, MAX_SATS+1, MAX_SAFE_INTEGER;
  quotePot overflow surface (MAX_SATS+1) documented.
- validateQuote: expiry at height, shallow anchor (<6 confirmations, incl.
  height before anchor), unsupported window (16, 1008); valid fixture passes.
- derivePKHs: correct side→key mapping for both makerSide values; refuses
  takerPKH==makerPKH (self-match guard).

Match transaction (`src/offers/matchTx.ts`):

- Malformed/non-canonical halfSignedHex (odd length, non-hex, trailing bytes,
  unparseable); uppercase hex accepted (canonical).
- Wrong input/output counts, non-zero nLockTime, non-final sequence,
  already-signed taker input, reused maker/taker outpoint.
- Wrong maker outpoint and wrong taker outpoint vs independent match context.
- Invalid maker signatures: missing half-signature, flipped SIGHASH byte
  (not ALL|FORKID), broken DER, pubkey not hashing to makerPKH, corrupted
  signature crypto (failed verification), wrong taker signing key.
- Covenant script tamper, wrong pot, maker change to stranger PKH, maker
  change dust, taker change to stranger PKH, taker change value mismatch.
- Stale currentHeight (QuoteValidationError) and mismatched prevout amount.

Maker service (`maker/service.ts`, `maker/ledger.ts`):

- Self-match take (taker outpoint == maker coin) refused.
- Replay take of same quote → RESERVED.
- Malformed take (bad takerPKH, bad txid) → INVALID_REQUEST.
- Six malformed vault responses → INVALID_VAULT_RESPONSE: non-hex, unsigned
  echo, dropped input, wrong signer pubkey, flipped SIGHASH, body tamper.

Maker HTTP (`maker/http.ts`):

- Unknown internal error → 503 UNAVAILABLE, detail never leaked.
- Unknown routes/methods → 404; non-JSON content-type → 415; OPTIONS → 204.

## Finding 1 — offline browser QA harness is stale at HEAD (test drift, not a safety hole)

- Repro: `python tests/board-browser.py`
  → `AssertionError: ('served', 'unset', 'Connecting to maker…')` at line 68.
- Cause: `tests/board-browser.py` (last changed cf19b92 "Add read-only Daily
  market board with honest offline states") asserts status strings that HEAD
  40beff0 renamed in `docs/index.html`:
  | case | harness expects | product now renders (docs/index.html) |
  |-----------------|-----------------|----------------------------------------------|
  | unset/offline/malformed | `Maker offline` | `maker offline — showing settled markets only` (L925/960) |
  | stopped | `Maker stopped` | `book stopped` (L813) |
  | stale | `Quotes stale` | `quotes stale` (L819) |
  live/dry-run/empty/expired/conflicting substrings still match.
- Impact: the browser regression harness cannot pass at HEAD, so the offline
  board flow is currently UNVERIFIED by its own harness. This is expectation
  drift in QA tooling, not a product fail-open: the board remains display-only
  (`docs/index.html` L751-752 "No wallet, key entry, /take or broadcast path
  exists in this increment"), both Take buttons render disabled, and the
  committed `qa/evidence/results.json` shows live + dry-run `passed:true`,
  `page_errors:[]`.
- Smallest fix (out of scope for this QA-only card; route to a dev card):
  update the `expected` map in tests/board-browser.py L38 to the current
  labels (and the unset initial-settle wait), then re-run.

## Remaining unverified boundaries

- Offline browser take-flow board: harness stale (Finding 1); not re-verified
  here. Product board is read-only by construction (no /take path).
- Live chain/provider integration, vault signing service, broadcast/settlement
  path: intentionally excluded (QA-only, offline). `maker/chain.ts`
  MainnetChain and real vault not exercised.
- Concurrency/killfile/stop-file timing and HTTP timeout enforcement
  (requestTimeout/headersTimeout/maxConnections): not adversarially probed.
- The full S9 regression inventory (1526 tests) lives on another branch; this
  worktree's 83-test suite is what was exercised.

## Verdict

No product fail-open defect found in the quote schema, match-tx library, maker
service, or maker HTTP boundary — every probed attack case fails closed. One
QA-tooling defect: the offline browser board harness expectations are stale at
HEAD (Finding 1). Product source unchanged; only an additive test file and this
report are committed.
