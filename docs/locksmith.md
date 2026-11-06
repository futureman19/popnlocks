# POP-1 locksmith (watchlist v1)

## Safety and scope

Default is **read-only**, without dotenv, a key, signer, funding selection, POSTs,
checkpoint writes or board writes. `--watch` repeats every 60 seconds; otherwise
one pass exits. Run from the repository root after `npm test` builds both artifacts.

```sh
npx ts-node scripts/locksmith.ts scripts/watchlist.example.json --dry-run
npx ts-node scripts/locksmith.ts watchlist.json --dry-run --watch
npx ts-node scripts/resume.ts watchlist.json --dry-run
```

The shipped example is deliberately an **empty list**, not invented live markets.
Mainnet smoke with it proves chain-info connectivity, not a funded settlement.
Production 144-header ladders are exercised in the local Script VM with locally
mined low-difficulty headers; no historical 2017 header download is needed.

`resume.ts` replaces the old hardcoded `<cranks> <txid>` demo CLI. It exports the
same reconstruction/retry engine used by locksmith, and its CLI delegates to
locksmith. The original POP-0 contract and eight tests remain unchanged; this
watcher only spends the separate POP-1 production artifact.

## Watchlist schema

A JSON array of records (all values are independently checked against the live
anchor and exact covenant output before spending):

| Field             | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `deployTxid`      | Lowercase 64-hex deployment ID; covenant must be output 0            |
| `anchorHeight`    | Positive integer mainnet height                                      |
| `anchorTipHex`    | Lowercase 64-hex SHA256d digest in **internal**, not explorer, order |
| `anchorBits`      | Compact difficulty uint32 as a JSON number                           |
| `window`          | Exactly `144`                                                        |
| `strikeTarget`    | Positive canonical decimal string, at most 256 bits                  |
| `yesPKH`, `noPKH` | Different lowercase 40-hex payout hashes                             |
| `bounty`          | Positive safe integer sats **per crank**                             |
| `pot`             | Original collateral sats, strictly greater than `3*bounty`           |

The watcher waits until `tipHeight >= anchorHeight + 144`, reconstructs and
hash-verifies the anchor and 144 headers from WOC block-height GETs, verifies PoW,
linkage, drift and floor, and captures the target of header 144. A final endpoint
reread catches a reorg during collection. Headers are paced (500ms after each
block read); 429s get bounded 65-second backoff. Errors halt rather than allowing
an unbounded retry/spend loop. A dedicated single operator owns the watchlist,
checkpoint directory and board file. Protect local configuration from writes by
untrusted users; watchlist records are not advertisements or discovery proofs.

## Write path (requires separate operator authorization)

**No production transaction was broadcast during implementation or acceptance.**
Only `--broadcast` enables writes; it cannot be combined with `--dry-run`.
Use an exclusively dedicated, minimally funded locksmith key in the gitignored
`.env` variable `LOCKSMITH_WIF`. Never point it at a treasury or asset wallet.
The operator must authorize funds/spending before running this mode.

The script uses the installed SDK's `TestWallet` as a basic local-key signer,
**not** a hardened custody service. Automatic fee-split transactions are disabled.
The funding provider selects only confirmed, mempool-unspent P2PKH outputs and
resolves their exact script/value from raw transactions. It does not classify
ordinal-bearing ordinary P2PKH coins, so the dedicated key must contain only
ordinary fee coins. Supply separate confirmed fee inputs for the three cranks
or wait for change to confirm; insufficient confirmed funds halt safely.

Each crank pays output 1 to that key's PKH. Output 0 is the next covenant with
`balance - bounty`, or the final winner with `pot - 3*bounty`. Funding inputs pay
fees at 100 sat/KB and any change returns to the locksmith. Bounty profitability
has not been established on mainnet; the spec's 1,500-sat example is not a fee
or profit guarantee. The contract itself is the existing Lite-DAA design, not
full consensus or SPV validation; WOC is a trusted mainnet read source here.

## Confirmation, retries and crash recovery

`.locksmith-state/<deployTxid>.json` is atomically written and gitignored:

```json
{ "txids": ["DEPLOYMENT_TXID", "FIRST_CRANK_TXID"] }
```

`txids.length - 1` is the number of completed cranks. The immutable market
parameters come from the watchlist; tip hash, previous target, endpoint target,
headers seen and remaining balance are rebuilt from headers on every rung.
The reconstructed full locking script/value must match the chain transaction.
The current outpoint must be unspent, and the endpoint is reread before spending.

On an **explicit ARC REJECTED / too-long-mempool-chain** response:

1. Clear the rejected candidate's pending marker; do not advance `txids`.
2. Poll the last accepted tip for at least one confirmation (30 seconds, bounded
   to 120 polls).
3. Rebuild that same rung from headers, reread the exact output and recheck the
   endpoint and unspent status; then continue. Limit depth retries to three.

`tests/locksmith.test.ts` verifies retry ordering, same-rung rebuilding, checkpoint
advance, and non-retry of ambiguous errors. Production tests independently run
all three real Script VM calls, both winners, wrong-side and bad-linkage attacks.

Before sending a candidate, the provider writes `pending: <candidateTxid>`.
It then requires ARC acceptance **and** byte-exact raw-transaction readback from
WOC before checkpoint advance. Timeouts, inconsistent responses or indexing
lag leave `pending` in place and **halt**. Restart also refuses a pending entry.
Never clear it just to retry:

- Resolve that candidate ID through WOC/ARC; verify its input 0 spends the saved
  tip, full output scripts/values match the next rung/winner, and chain status.
- If accepted, append its ID once to `txids`, remove `pending`, then restart.
- If definitively rejected and the old tip remains unspent, remove `pending`;
  restart only after resolving the rejection cause.
- If unknown, wait/investigate. Do not construct or broadcast a competing tx.

The process uses `.locksmith.lock` to prevent concurrent writers. After a crash,
first confirm the old process is gone and reconcile any pending candidate before
removing a stale lock. An externally cranked/spent market halts for operator
lineage reconciliation; v1 does not automatically adopt another locksmith's
chain. Reorgs after publication require operator reconciliation; the board is
not an automatic reorg indexer.

## Settlement board file

After the final tx has **one confirmation**, the watcher rereads the complete
four-transaction lineage, all continuation balances/scripts and winner payout,
and rechecks the endpoint. Only then it appends to `docs/data/pops.json`:

```text
[
  {
    "marketId": <deployment txid>,
    "market": <full watchlist record>,
    "txids": [<deployment>, <crank 1>, <crank 2>, <settlement>],
    "winnerSide": "yes" | "no"
  }
]
```

This is a plain JSON array. IDs and decimal target strings remain strings;
satoshi amounts remain numbers. Appending is atomic and idempotent by market ID;
a conflicting existing record fails closed. A crash after the last checkpoint
but before append is repaired on restart without another crank. No samples or
dry-run results are mixed with confirmed records. Publishing the updated static
file to a hosted board is a separate deployment, not part of this watcher.
