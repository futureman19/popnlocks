# Daily Pop maker (local v1)

Run from the repository root after `npm install` and `npm test`:

```
npm run maker
```

Default is **DRY-RUN**: mainnet header reads only, no vault subprocess, no funding inventory reads, no keys, no broadcast. Listen defaults to `127.0.0.1:8787`. `GET /quotes` returns `{quotes: Quote[], status: {...}}`; initial/failed refresh returns an empty list. The default all-zero maker PKH is an explicitly non-trading placeholder, not a wallet address. Consumers must inspect `status.mode` and disable taking dry-run quotes.

## API contract

- `GET /quotes`: WO-1 quote records, plus additive status (mode, stopped, stale, currentHeight, refreshedAt milliseconds, inventory or null, feeRate=100). `makerSide=no` sells YES to the taker; `makerSide=yes` sells NO. Stakes are integer satoshis, not decimal probabilities.
- `POST /take` with JSON `{quoteId,takerPKH,takerInput:{txid,vout}}`: 200 `{halfSignedTxHex}`; 409 `{error:code}` for dry-run/stale/stopped/exposure/coin/vault-cap declines; malformed JSON 400, oversized body 413, foreign browser origin 403, upstream/internal failure 503. Only an outpoint is accepted; actual prevout values/scripts/unspentness are independently resolved.
- The taker independently resolves **both** prevouts and authenticates the accepted quote, fresh chain height and anchor, then uses WO-1 `takerComplete` with feeRate **100 sat/KB**. Never infer previous values from the returned outputs. Taker broadcasts; this service contains no broadcast path. The half-signed response alone is not a safe wallet signing context.
- Exact allowed CORS origin defaults to `https://popnlocks.com`; localhost/browser preview must explicitly configure its origin. No cookies/auth secrets. Put a public deployment behind TLS, request-rate limits and appropriate abuse controls.

## Pricing and cadence

One Daily Pop, no Weekly artifact. Anchor is the latest 144-block boundary buried at least six blocks. Trading closes at anchor+144; the following anchor's six-block maturity gap produces no quotes. Quote expiry is min(tip+3, endpoint); wall-clock freshness limit 90 seconds. Refresh repeats 20 seconds after completion; requests are serialized. WOC's shared read-only reader validates header hashes, throttles header calls, applies 30-second request timeouts and bounded 65-second backoff on 429. Failure empties the book.

Use fifteen targets sampled 144 blocks apart (fourteen log returns), estimate log-return mean/variance, and scale to the remaining window using the latest target. Covenant YES means endpoint target **<=** anchor strike; exact equality wins. Raw log-normal probabilities are shrunk using `(14*p+1)/16`, a symmetric two-pseudo-observation prior, because fourteen samples cannot establish certainty. This deliberately keeps both sides available instead of claiming near-certain probabilities. It is a v1 heuristic, not a calibrated forecast or profit guarantee.

YES/NO asks are p+0.04 and 1-p+0.04: eight percentage points total spread. For fixed pot P and three bounties B, net payout W=P-3B; taker stake=3B+ceil(ask\*W), maker stake=P-taker stake. This recovers crank costs rather than silently consuming the spread. Rounding is against the taker. Display actual stake and net payout, including this bounty cost.

## Safety and operator configuration

`npm run maker -- --config=maker/config.local.json` stays dry. The example config is public/non-secret. A future authorized operator may additionally supply `--live`; this task did **not** run it. Live mode requires explicit maker PKH, vault working directory and positive risk/coin limits. Never put keys in config. Do not use any treasury address.

`STOP_MAKER` is checked on each HTTP view/take, immediately before durable reservation and signer invocation, and every 10 seconds in the daemon. In-flight signatures cannot be revoked by a later killfile. Vault separately honors its own STOP_SPENDING and caps. A stopped book remains empty until the next successful refresh after removal.

One live process per state directory is enforced by an exclusive lock. A crash leaves the lock for human review; never auto-delete a stale lock. Holds are fsynced **before** requesting a signature; timeouts, vault errors, and malformed/tampered responses retain the hold. The exact unsigned transaction body and maker ALL|FORKID signature are verified before returning hex.

Market exposure is aggregate maker stake per anchor. Daily cap is conservatively charged for **all unresolved holds**, including previous days: a half-signature remains spendable after quote expiry, so midnight is not permission to release it. There is intentionally no automated reconciliation or release endpoint. An operator must establish a coin was spent/invalidated and reconcile retained evidence before any manual state maintenance; never clear a ledger merely to reset limits. Vault also accounts full input value independently.

Sized-coin selection chooses the smallest unreserved coin covering stake + explicit fee share + 546-sat change, bounded by maxCoinSats. `/quotes` status exposes inventory in live mode only. A human prepares ordinary stake-sized funding coins using the vault's split operation; the bot never splits, sweeps, funds, or accesses keys. `NO_SIZED_COIN` calls for inventory maintenance. `VAULT_CAP` means resize coins or wait/reconcile the vault's daily limit, not retry blindly. Every ambiguous attempt retains exposure.

## Vault transport

Requires Dogfood `18de0be` or newer with `popnlocks-sign --stdin` support. The fixed command is `bun src/cli.ts popnlocks-sign --stdin 0`; transaction hex is piped as ASCII and stdin is closed immediately (EOF), never placed in argv. The maker rejects malformed or over-1,048,576-byte input before spawning. The vault independently caps stdin at the same size and requires EOF within 10 seconds; its policy/key/signing gates are unchanged. The maker retains the existing 120-second overall subprocess timeout, 2 MiB output bound, no-shell execution and conservative exposure hold on any failure. No legacy argv fallback: production Daily covenant hex exceeds Windows command-line capacity.

The transport regression sends a real WO-1 production deploy through an **inert Node echo child**, verifies byte identity and bounded argv, and never invokes the vault. It also exercises the exact 1 MiB boundary, oversize refusal, child rejection and missing-executable errors.

## Verification

`npm test` includes maker pricing, scheduler, exposure, killfile, dry-run, prevout, HTTP and offline disposable-signature tests. `npm run typecheck:maker` includes daemon and tests. No live signing/funding/broadcast is needed. The tests' random testnet keys are disposable local fixtures, never vault keys.
