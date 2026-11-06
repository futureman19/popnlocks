# popnlocks

**pop nLocks** — self-settling hashrate derivatives on Bitcoin (BSV). The chain attests to its own vital signs; the winner pops the lock.

Three layers deep: **nLock** (the timelock field), **pop the lock** (settlement: header proofs pop the covenant open), **pop and lock** (the dance).

## What it is

A binary market on BSV network difficulty, settled by the chain itself — no oracle, no reporter, no dispute window.

> "Will consensus difficulty be at or above strike **K** at the end of the window?"

- YES/NO collateral locks into a covenant at deploy.
- After the window, **anyone** settles by presenting the real block headers.
- The covenant verifies linkage + proof-of-work + difficulty-drift bounds in-script and pays the winner.
- Settlement runs as a crank-per-chunk ladder (stateful continuation outputs); the final crank pays the winner plus a crank bounty. Keepers are called **locksmiths**.

Forging settlement data requires performing the work being measured. The oracle _is_ the thing being predicted.

## Status

POP-0 (binary difficulty market) — mainnet end-to-end run executed 2026-11-06: deploy → 3 cranks → settle, all mined in block **974267**. See [`docs/POP-0-binary-difficulty-market.md`](docs/POP-0-binary-difficulty-market.md) for the full spec, evidence txids, and ops notes — and [`docs/writeup-pop-0.md`](docs/writeup-pop-0.md) for the long-form account. Site: [popnlocks.com](https://popnlocks.com).

## Build & test

```sh
npm install
npm test          # golden headers, synthetic attacks, offline offer/match tests
```

## Offline POP-1 offer/match library

`src/offers/quoteSchema.ts` validates quote records without network access.
`src/offers/matchTx.ts` builds and signs an atomic two-input deployment:

```ts
const tx = buildDeployTx(
  quote,
  makerUtxo,
  takerUtxo,
  takerPKH,
  feeRate,
  currentHeight
);
const halfSignedHex = makerSign(tx, makerKey, 0);
const finalHex = takerComplete(halfSignedHex, takerKey, {
  acceptedQuote: quote,
  makerPrevouts: [makerUtxo],
  takerPrevouts: [takerUtxo],
  feeRate,
  currentHeight,
});
```

Fee rate is integer sat/KB. v1 accepts exactly one P2PKH prevout per party,
requires non-dust change for both, and returns raw transaction hex (no cache or
envelope). Before taker signing, it checks the exact covenant bytes from a fresh
local artifact instantiation, pot, outpoints, both changes, and maker ALL|FORKID
signature. Callers must independently authenticate the accepted quote, resolve
both prevouts, verify the anchor/bits and obtain a fresh height. This library
neither queries a node nor broadcasts; locally valid signatures do not establish
that the supplied funding outputs exist or remain unspent.

**Test-only geometry:** the current binding carries **16 post-anchor headers**,
settles on **index 12 (the 13th header)**, and verifies chunks of 4. Three headers
follow the endpoint. `quote.window` means total carried headers, **not** the
endpoint position. YES means endpoint target <= strike target. These are not
production daily/weekly markets.

`src/offers/marketContract.ts` binds the local class and artifact name. The
supported window, chunk and endpoint are derived from that class's constants;
a quote cannot choose another contract or override its geometry. WO-4 must bind
its reviewed production class/artifact there; geometry then follows automatically
without numeric allowlist or match-transaction changes. Merely placing a second
artifact on disk does not enable it. Rebuild class and artifact together with
`npm test` before use; never substitute untrusted or stale compiled artifacts.

## On-chain

```sh
npx ts-node scripts/onchain-demo.ts           # deploy + settle a retro market (needs funded .env key)
npx ts-node scripts/resume.ts <cranks> <txid> # resume a ladder from its tip UTXO after mempool-depth limits
```

Mainnet notes baked into the spec: ≥100 sat/KB (scrypt-ts default is miner-invisible), broadcast via ARC, keep unconfirmed ladders ≤3 links.
