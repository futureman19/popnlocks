# Popnlocks offline timeout/concurrency QA — t_62e2ce8f

- Lane: telegram3 · Branch: `wt/codex-quote-concurrency`
- Verified base: `e435fb348906bee54558652d11553cf8abc390c6`, with both `40beff011cc6beef2407ba34a8606c1ba2fc85ac` and `bb35009df8dea474fac0fa835310ff9e61deeb99` confirmed as ancestors.
- Scope: additive adversarial QA only. Product source is unchanged. The prior timed-out attempt left the probe draft in this card-owned worktree; this run executed, reviewed, and completed that draft.
- Fixtures: runtime-generated disposable testnet keys, synthetic quotes/coins, fake chain responses, temporary file-backed ledgers, loopback HTTP, and intercepted browser transport. No operational wallet, credentials, funded coins, live chain/provider/DNS access, broadcast, push, deploy, spend, or release claim.

## Commands and results

1. `env -u PRIVATE_KEY NETWORK=local npm_config_offline=true npx --no-install mocha tests/qaTimeoutConcurrency.test.ts`
   - Mocha's configured `./tests/**/*.test.ts` spec also ran the complete suite: **92 passing / 0 failing** (7s), including the 9 new focused tests.
2. `env -u PRIVATE_KEY NETWORK=local npm_config_offline=true npx --no-install mocha`
   - Exact required full-suite command: **92 passing / 0 failing** (8s). Baseline 83 plus 9 new focused tests.
3. `python tests/board-browser.py`
   - **22/22 existing fixture scenarios passed** (11 served + 11 file).
   - **2/2 new focused polling probes passed**.
   - Both unmodified real served/file offline documents passed; the production `/quotes` request was blocked before DNS. The Receipts section was unchanged.
4. `env npm_config_offline=true npx --no-install prettier --check tests/qaTimeoutConcurrency.test.ts`
   - Passed.
5. `env npm_config_offline=true npx --no-install eslint tests/qaTimeoutConcurrency.test.ts`
   - Passed with no findings.
6. `git -c core.whitespace=cr-at-eol diff --check`
   - Passed. Git emitted only its existing LF-to-CRLF working-copy warning for `tests/board-browser.py`.

## Covered attack cases

### Maker HTTP and freshness

- Production server defaults are asserted as 15-second request and 10-second header timeouts; the QA-only server instance shrinks both so real Node header/body timeout paths execute quickly over loopback.
- Incomplete headers and a slow partial JSON body receive generic `408` responses. Synthetic secret markers do not appear in either response.
- A slow in-flight HTTP take holds the single signature path; an overlapping take receives bounded `409 BUSY` without another signer call.
- A signer failure containing a synthetic internal/secret marker becomes `503 {"error":"UNAVAILABLE"}`; the marker is not leaked and the durable hold remains.
- Stale and stopped HTTP views expose empty books and truthful status flags.
- A height response delayed beyond the 90-second quote freshness boundary is rejected as `STALE_QUOTE` before reservation or signing.

### Concurrent quotes, replay, and coin reuse

- With the first signer deliberately paused, duplicate and distinct overlapping takes fail synchronously as `BUSY` before another height read; exactly one signer invocation and one hold occur.
- A replayed quote ID after a successful offline half-signature fails as `RESERVED` without another signer call.
- Duplicate quote IDs in the current book cannot bypass an existing hold.
- Direct ledger reuse of an already-reserved coin under a different quote ID fails as `RESERVED`.
- A second maker instance sharing the durable ledger cannot reserve the held coin; it declines before signing and adds no hold.

### STOP_MAKER / killfile transitions

- A pre-existing killfile rejects before height access, reservation, or signing.
- A killfile appearing during prevout resolution is checked again before durable reservation; no hold or signature is created.
- A killfile appearing immediately after reservation prevents signer invocation and retains the durable hold; subsequent takes remain stopped.
- A killfile appearing inside an already-authorized in-flight signature does not revoke that signature, while all new takes and book visibility remain stopped. This preserves the documented conservative boundary rather than treating either in-flight completion or a durable hold as a fail-open defect.

### Real-browser polling

- A controlled slow request has no overlapping poll at 9,999 ms, aborts at 10 seconds, enters the honest maker-offline state, and issues its next serialized poll only after the 20-second completion-based delay.
- A delayed older producer snapshot renders stale/empty prices, never its stale prices over the live display. A later valid response recovers the expected current prices, with no overlap and GET-only quote polling.
- Existing served/file honest-state, disabled-Take, mobile-overflow, reduced-motion, expiry, malformed/conflicting-data, history, and Receipts assertions remain intact.

## Defects

No product fail-open defect was reproduced in these scoped probes. No product fix or scope expansion was made.

## Residual unverified boundaries

- Real chain/provider behavior, operational vault signing, funded coins, broadcast, settlement, and deployment are intentionally excluded.
- Timeout behavior was exercised with shrunk QA-instance timers plus assertions on the production defaults; this is not a wall-clock soak test at 10/15 seconds.
- Browser timing is deterministic Playwright virtual-clock coverage with intercepted transport, not a public-network test.
- Cross-process adversarial writers outside the documented single-process state-directory lock were not probed. Shared-ledger reuse and in-process concurrency were probed.
- These offline results are not wallet, trading, broadcast, push, deploy, or release approval.
