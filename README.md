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
npm test          # 8/8 — golden header chain + synthetic attack chains
```

## On-chain

```sh
npx ts-node scripts/onchain-demo.ts           # deploy + settle a retro market (needs funded .env key)
npx ts-node scripts/resume.ts <cranks> <txid> # resume a ladder from its tip UTXO after mempool-depth limits
```

Mainnet notes baked into the spec: ≥100 sat/KB (scrypt-ts default is miner-invisible), broadcast via ARC, keep unconfirmed ladders ≤3 links.
