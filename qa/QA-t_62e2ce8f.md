# Popnlocks offline timeout/concurrency QA — t_62e2ce8f

- Lane: telegram3 · Branch: `wt/codex-quote-concurrency`
- Amendment base: `8f4b669578883e2810c3dbc1e14db2ab1b211550`; both `e435fb348906bee54558652d11553cf8abc390c6` and `40beff011cc6beef2407ba34a8606c1ba2fc85ac` were confirmed as ancestors before edits.
- Scope: additive QA/evidence amendment only. The only amended files are `tests/qaTimeoutConcurrency.test.ts`, `tests/board-browser.py`, and this report. Product source is unchanged.
- Fixtures: runtime-generated disposable testnet keys, synthetic quotes/coins, fake chain responses, temporary file-backed ledgers, loopback HTTP, and intercepted browser transport. No operational wallet, credentials, funded coins, live chain/provider/DNS access, broadcast, push, deploy, spend, or release claim.

## Correction to earlier evidence

The earlier `8f4b669` report called `npx --no-install mocha tests/qaTimeoutConcurrency.test.ts` a focused run, but `.mocharc.json` also selected `./tests/**/*.test.ts`, so that command ran all 92 tests rather than a focused 9. Its `env -u PRIVATE_KEY` full-suite command was also not credential-isolated evidence: `tests/utils/privateKey.ts` calls `dotenv.config({path: '.env'})`, which can reload a repository `.env` after the inherited variable is unset. Those two pieces of evidence are withdrawn and replaced by the explicit focused command and disposable tracked-tree isolation below. No credential value was printed.

## Commands and results

1. `env -u PRIVATE_KEY NETWORK=local npm_config_offline=true node C:/Users/futur/Desktop/popnlocks/node_modules/mocha/bin/mocha.js --no-config --no-package --require ts-node/register --timeout 3000 tests/qaTimeoutConcurrency.test.ts`
   - Explicitly bypasses Mocha config/package spec expansion: **9 passing / 0 failing**.
2. Disposable credential-isolated full suite, from the amended commit's `git archive HEAD` in scratch `C:/Users/futur/.hermes/profiles/telegram3/cache/scratch/popnlocks-qa-t_0eb3dd1c-final`:
   - `git archive HEAD | tar -x -C /c/Users/futur/.hermes/profiles/telegram3/cache/scratch/popnlocks-qa-t_0eb3dd1c-final`
   - Copied only generated `artifacts/`, `dist/`, and `scrypt.index.json` from the reviewed worktree; created the scratch `node_modules` junction with `cmd.exe /c mklink /J C:\Users\futur\.hermes\profiles\telegram3\cache\scratch\popnlocks-qa-t_0eb3dd1c-final\node_modules C:\Users\futur\Desktop\popnlocks\node_modules`.
   - `cd /c/Users/futur/.hermes/profiles/telegram3/cache/scratch/popnlocks-qa-t_0eb3dd1c-final && env -u PRIVATE_KEY NETWORK=local npm_config_offline=true node C:/Users/futur/Desktop/popnlocks/node_modules/mocha/bin/mocha.js`
   - The tracked-tree archive contained no `.env`, and the inherited `PRIVATE_KEY` was unset. The first run logged `Private key generated and saved in ".env"`, not that an existing key was used; the disposable `.env` existed only in scratch and its value was never printed. **92 passing / 0 failing** (baseline 83 plus focused 9).
3. `python tests/board-browser.py`
   - **22/22 existing fixture scenarios passed** (11 served + 11 file).
   - **2/2 focused polling probes passed**, including hide/resume while the first quote fetch was pending, the existing 10-second timeout, and the serialized 20-second retry.
   - **1 separate sequential fresh-but-older characterization recorded a DEFECT**, detailed below; it is not counted as a safety pass.
   - Both unmodified real served/file offline documents passed; the production `/quotes` request was blocked before DNS. The Receipts section was unchanged.
4. `env npm_config_offline=true npx --no-install prettier --check tests/qaTimeoutConcurrency.test.ts`
   - Passed.
5. `env npm_config_offline=true npx --no-install eslint tests/qaTimeoutConcurrency.test.ts`
   - Passed with no findings. The generated `.eslintcache` change was restored and was not committed.
6. `git -c core.whitespace=cr-at-eol diff --check`
   - Passed. Git emitted only LF-to-CRLF working-copy warnings for the amended files.

## Covered attack cases

### Maker HTTP and freshness

- Production server defaults are asserted as 15-second request and 10-second header timeouts; the QA-only server instance shrinks both so real Node header/body timeout paths execute quickly over loopback.
- The incomplete-header and partial-body requests carry distinct harmless canaries. Both responses have the exact status line `HTTP/1.1 408 Request Timeout`, and neither response echoes either canary.
- A slow in-flight HTTP take holds the single signature path; an overlapping take receives bounded `409 BUSY` without another signer call.
- A signer failure containing a synthetic internal/secret marker becomes exact `503` body `{"error":"UNAVAILABLE"}`; the marker is not leaked and the durable hold remains.
- Stale and stopped HTTP views expose empty books and truthful status flags.
- A height response delayed beyond the 90-second quote freshness boundary is rejected as `STALE_QUOTE` before reservation or signing.

### Concurrent quotes, replay, and coin reuse

- The first take is paused at its **first** `chain.height` call. Duplicate and distinct competitors both fail as `BUSY` before any additional height read, durable hold, or signer invocation. Releasing the first height permits exactly one signer invocation and one hold.
- A replayed quote ID after a successful offline half-signature fails as `RESERVED`; `heightCalls` is recorded before the request and asserted unchanged afterward, with no additional signer call or hold.
- Duplicate quote IDs in the current book cannot bypass an existing hold.
- Direct ledger reuse of an already-reserved coin under a different quote ID fails as `RESERVED`.
- A second maker instance sharing the durable ledger cannot reserve the held coin; it declines before signing and adds no hold.

### STOP_MAKER / killfile transitions

- A pre-existing killfile rejects before height access, reservation, or signing.
- A killfile appearing during prevout resolution is checked again before durable reservation; no hold or signature is created.
- A killfile appearing immediately after reservation prevents signer invocation and retains the durable hold; subsequent takes remain stopped.
- A killfile appearing inside an already-authorized in-flight signature does not revoke that signature, while all new takes and book visibility remain stopped. This preserves the documented conservative boundary rather than treating either in-flight completion or a durable hold as a fail-open defect.

### Real-browser polling

- While the first controlled quote fetch is pending, a synthetic hidden event followed by a visibility-resume event starts no second fetch and leaves the original request active.
- The same controlled slow request has no overlapping poll at 9,999 ms, aborts at 10 seconds, enters the honest maker-offline state, and issues its next serialized poll only after the 20-second completion-based delay.
- A delayed **expired** producer snapshot renders stale/empty prices, never its stale prices over the live display. A later valid response recovers the expected current prices, with no overlap and GET-only quote polling. This remains a separate case from the fresh-but-older characterization below.
- Existing served/file honest-state, disabled-Take, mobile-overflow, reduced-motion, expiry, malformed/conflicting-data, history, and Receipts assertions remain intact.

## Reproduced defect

**DEFECT — sequential fresh-but-older producer snapshot overwrites newer displayed prices.** This is a characterization result, not a safety PASS.

- The initial intercepted response had `status.refreshedAt = 1795718390000` and rendered **YES `5,400 sats` / NO `6,000 sats`**.
- After that response completed, the next sequential poll returned `status.refreshedAt = 1795718380000` (10,000 ms older), still only about 40 seconds old at observation and therefore inside the 90-second freshness window.
- The board remained in `Dry-run` rather than stale/offline and rendered **YES `1,111 sats` / NO `2,222 sats`**, overwriting the newer values.
- The probe uses sequential completed responses, not an out-of-order delayed response. `docs/index.html` currently assigns `book=data` without comparing producer timestamps. No product edit was made in this QA-only card. This stale-display defect must not be described as a verified safety candidate without separate disposition.

## Harness corrections

One harness defect occurred during amendment: the first deterministic-clock attempt passed milliseconds to Playwright Python's seconds-based `clock.install(time=...)` parameter and timed out before making an observation. A minimal local clock probe isolated the unit error; the corrected full browser run reproduced the product values above. That harness timeout was not classified as a product failure.

## Residual unverified boundaries

- Real chain/provider behavior, operational vault signing, funded coins, broadcast, settlement, and deployment are intentionally excluded.
- Timeout behavior was exercised with shrunk QA-instance timers plus assertions on the production defaults; this is not a wall-clock soak test at 10/15 seconds.
- Browser timing is deterministic Playwright virtual-clock coverage with intercepted transport, not a public-network test. The fresh-but-older characterization covers the stated two-response dry-run sequence only.
- Cross-process adversarial writers outside the documented single-process state-directory lock were not probed here. Shared-ledger reuse and in-process concurrency were probed.
- These offline results are not wallet, trading, broadcast, push, deploy, or release approval.
