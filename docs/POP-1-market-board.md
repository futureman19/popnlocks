# POP-1: Market Board + House Maker (matched-pair markets)

**Status: DRAFT — ready for implementation. Builds on POP-0 (settlement covenant, mainnet-verified block 974267).**

## 1. Shape

Two recurring flagship markets, always on schedule — scarcity concentrates liquidity:

| Market         | Window                | Cadence                            |
| -------------- | --------------------- | ---------------------------------- |
| **Daily Pop**  | 144 blocks (~1 day)   | starts daily, settles next day     |
| **Weekly Pop** | 1008 blocks (~1 week) | starts Monday, settles next Monday |

Rationale: BSV's cw-144 DAA nudges difficulty ~1/144 per block; windows shorter than
~144 blocks resolve on noise. Daily is the floor. (Hourly/10-min markets were
considered and rejected: zero variance, zero interest.)

The **house maker bot** quotes both YES and NO on each flagship, standing sizes,
so a taker always finds a counterparty — blackjack against the house while the
userbase is small. Pari-mutuel pools are POP-2 (deferred deliberately).

## 2. Offer/match protocol

No funds move until a match exists. Quotes are data, not transactions.

**Quote record (JSON):**

```
{ quoteId, market: {anchorHeight, anchorTipHex, anchorBits, window, strikeTarget, bounty},
  makerSide: "yes"|"no", makerStake, takerStake, makerPKH, expiryHeight }
```

**Match flow (request-response; maker is always online):**

1. Taker picks a quote on the board, supplies `takerPKH` + funding outpoint.
2. Maker API (`POST /take {quoteId, takerPKH, takerInput}`) validates the quote
   (live, unexpired, exposure limits OK), constructs the deploy tx:
   inputs = maker UTXO + taker UTXO; outputs = covenant(pot = makerStake +
   takerStake, yesPKH/noPKH per sides) + change outputs.
3. Maker signs its input (SIGHASH_ALL), returns the half-signed tx hex.
4. Taker's wallet signs its input, broadcasts. Atomic: either both fund or nothing moves.
5. Maker marks the quote filled and re-quotes.

Anchor rule (from POP-0 §risks): anchor block must have ≥6 confirmations at deploy.

## 3. Settlement ops

- Production contract params: `WINDOW=144`, `CHUNK=48` (3 cranks), endpoint = final
  header of window. Recompile artifact; existing POP-0 tests must stay green.
- Crank fee at 48 headers ≈ ~12 KB tx ≈ ~1,200 sats at 100 sat/KB → **bounty 1,500
  sats/crank** (fee + margin). Bounty rides in the pot; maker funds it into pricing.
- **Locksmith watcher**: bot auto-cranks any live market whose window has ended;
  bounties remain anyone-callable (future agent job board — Gryd tie-in).
- `scripts/resume.ts` already handles mempool-depth interruptions; generalize its
  params (it currently hardcodes the demo geometry).

## 4. Maker pricing v1

- Model: P(endpointTarget ≥ strike) estimated from trailing per-144-block drift,
  log-normal approximation. v1 strike = anchor target ("will difficulty rise over
  the window?") — a true coin-flip-shaped question, tightest possible spread case.
- Quote both sides with a fixed house spread (start 8% wide).
- Limits: max stake per market, max daily exposure, `STOP_MAKER` killfile honored
  within 30s. Default mode on first deploy: **dry-run** (quotes computed, no signing)
  until the user flips it live.
- Maker keys live in a separate funded wallet (`maker/.env`, gitignored), never the
  treasury, never the repo.

## 5. Board UI (popnlocks.com)

New "Markets" section above Receipts: flagship cards with live YES/NO prices,
countdown to window close, stake sizes, and a Take button. Settlement history from
chain (recent pops). v1 taker signing via **Yours Wallet** (the user's QA wallet);
advanced paste-key fallback clearly marked as such.

## 6. Work orders (kanban)

- **WO-1** `offer-match library`: quote schema, deploy-tx builder, half-sign/complete
  flow, unit tests with golden vectors. No network writes in tests.
- **WO-2** `maker bot`: pricing model, /quotes + /take endpoints, exposure limits,
  killfile, dry-run default. Depends on WO-1.
- **WO-3** `board UI`: markets section, quote display, Yours-wallet take flow,
  settlement history. Depends on WO-1.
- **WO-4** `production params + locksmith watcher`: CHUNK=48/WINDOW=144 artifact,
  flagship deploy scheduler, auto-crank watcher, resume.ts generalization.
  Independent of WO-1.

## 7. Security & limits

- Maker wallet float is user-funded and capped; loss bounded by float, not treasury.
- Quote expiry = a few blocks; stale quotes are simply declined at /take.
- Reorg at anchor: quotes refuse anchors with <6 confs; matched deploys re-verify.
- The covenant remains the sole payout authority — all client/maker code is untrusted.
