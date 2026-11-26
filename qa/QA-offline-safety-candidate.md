# Popnlocks offline safety candidate — integration QA

Status: assembled local candidate pending manager review. This is not independent final approval, a push, a deploy, or a release.

## Integrated revisions and inherited evidence

- Product base and required starting HEAD: `40beff011cc6beef2407ba34a8606c1ba2fc85ac`; the integration worktree started clean on `wt/kimi-offline-safety-candidate`.
- Timeout/polling plus stale-display source: `wt/kimi-stale-display-fix` at exact `2cf644dc95720be9f68fb5390c172113823f6a51`; its source worktree was clean before merge.
- Cross-process ownership source: `wt/codex-cross-process-reservations` at exact `5be6b5affa8df905691bb75d3dd8eec34dc32400`; its source worktree was clean before merge.
- First local merge commit: `1b580669f4666863506323b86836def0d5ff78aa` (`--no-ff --no-edit wt/kimi-stale-display-fix`).
- Merged code/QA tree used for the fresh gates below: `0fe569cedbd18e78a09bc8e2784e9117a93cc08b` (`--no-ff --no-edit wt/codex-cross-process-reservations`). Both merges completed without conflicts or product conflict resolution.
- `git merge-base --is-ancestor <sha> HEAD` passed for `40beff011cc6beef2407ba34a8606c1ba2fc85ac`, `e435fb348906bee54558652d11553cf8abc390c6`, `8f4b669578883e2810c3dbc1e14db2ab1b211550`, `d4225af2f12edcfdb4225b4ceaf64ac98cc44f34`, `2cf644dc95720be9f68fb5390c172113823f6a51`, `a22d5ac03798c708247d51c47a3bd63ad4653ce0`, and `5be6b5affa8df905691bb75d3dd8eec34dc32400`.

Inherited, independently reported evidence is retained in `qa/QA-stale-display-fix.md`, `qa/QA-t_62e2ce8f.md`, `qa/QA-t_272a2b29.md`, and `qa/QA-t_de0eca7e.md`. In particular, the stale-display fix card and its fresh reviewer passed; the cross-process card reported one durable hold and one inert signer call per race, with lock and hold retained across process death. The historical fresh-but-older defect recorded in `QA-t_62e2ce8f.md` is dispositioned by `2cf644d`; the merged regression below is a fresh pass, not a quotation of that old defect characterization.

## Final diff and transport review

The complete `40beff0..0fe569c` diff was inspected. It contains nine paths: the one permitted product file plus tests and QA evidence. Relative to product base `40beff011cc6beef2407ba34a8606c1ba2fc85ac`, `docs/`, `src/`, `maker/`, `artifacts/`, and `data/` differ only by this added line in `docs/index.html`:

```js
if (book && s.refreshedAt < book.status.refreshedAt) return;
```

`git diff 2cf644dc95720be9f68fb5390c172113823f6a51..HEAD -- docs src maker artifacts data` was empty before this report-only commit. No additional product behavior, dependency, configuration, Receipts, generated artifact, or formatting change was merged.

No operational secret, private-key value, funded wallet material, or new external transport was found in the complete added-line review. Added network activity in tests is loopback-only or explicitly intercepted. The production `https://api.popnlocks.com/quotes` string in browser QA is used to deny the real request before DNS, not to contact it. No push, deploy, broadcast, wallet, vault, credential, funds, live chain/provider/DNS, spending, tag, or host configuration operation was performed.

## Fresh gates on the merged tree

### Focused timeout/concurrency

```bash
env -u PRIVATE_KEY NETWORK=local npm_config_offline=true node C:/Users/futur/Desktop/popnlocks/node_modules/mocha/bin/mocha.js --no-config --no-package --require ts-node/register --timeout 3000 tests/qaTimeoutConcurrency.test.ts
```

Result: exit 0, **9 passing / 0 failing**. Only the pre-existing module-type warning was emitted.

### Focused cross-process ownership

```bash
env -u PRIVATE_KEY NETWORK=local npm_config_offline=true node C:/Users/futur/Desktop/popnlocks/node_modules/mocha/bin/mocha.js --no-config --no-package --require ts-node/register --timeout 3000 tests/qaReservationOwnership.test.ts
```

Result: exit 0, **5 passing / 0 failing**. The five cases cover same-quote ownership/restart replay, distinct-quote coin reuse, prior-day hold retention, stop before reservation, and abrupt-exit lock/hold retention without signing.

### Credential-isolated full Mocha

The exact merged `0fe569c` tree was exported with `git archive --format=zip HEAD` into disposable scratch `C:/Users/futur/.hermes/profiles/telegram3/cache/scratch/popnlocks-qa-t_424cef1b-merged` and extracted with Python `zipfile`. The archive had no `.env`. Only generated `artifacts/`, `dist/`, and `scrypt.index.json` were copied from `C:/Users/futur/Desktop/popnlocks`. Scratch `node_modules` was a junction to the existing main dependency tree. From scratch:

```bash
env -u PRIVATE_KEY NETWORK=local npm_config_offline=true node C:/Users/futur/Desktop/popnlocks/node_modules/mocha/bin/mocha.js
```

Result: exit 0, **97 passing / 0 failing**. The log contained `Private key generated and saved in ".env"`, did not contain the existing-key marker, and a nonempty disposable `.env` existed only in scratch afterward. No key value was read or printed. Output was captured and only the marker/totals were reported. The junction was removed with `cmd.exe /c rmdir`, then scratch and its archive were deleted and confirmed absent.

### Real Chromium board QA

```bash
python tests/board-browser.py
```

Result: exit 0:

- **22/22 existing fixture scenarios** passed: 11 served plus 11 file.
- **2/2 focused polling probes** passed: slow-request timeout/serialization and delayed-stale-response retention/recovery.
- **1/1 sequential fresh-older/newer-recovery regression** passed. At `refreshedAt 1795718390000 -> 1795718380000` ms, observed older age **40,117 ms** (<90,000 ms), the board retained YES `5,400 sats`, NO `6,000 sats`, and the newer expiry schedule. A subsequent `1795718410000` ms snapshot at observed age **30,124 ms** was accepted with YES `7,700 sats`, NO `8,800 sats`, 30 blocks to close, and quote expiry block `974,422`.
- Both real unmodified served/file offline documents passed. Production GET `/quotes` was blocked before DNS. Quote calls were GET-only and Receipts were unchanged.

### Formatting, lint, and whitespace

```bash
env npm_config_offline=true node C:/Users/futur/Desktop/popnlocks/node_modules/prettier/bin-prettier.js --check --ignore-unknown docs/index.html tests/board-browser.py tests/qaTimeoutConcurrency.test.ts tests/qaReservationOwnership.test.ts tests/qaSafetyAdversarial.test.ts qa/QA-stale-display-fix.md qa/QA-t_272a2b29.md qa/QA-t_62e2ce8f.md qa/QA-t_de0eca7e.md
env npm_config_offline=true node C:/Users/futur/Desktop/popnlocks/node_modules/eslint/bin/eslint.js tests/qaTimeoutConcurrency.test.ts tests/qaReservationOwnership.test.ts tests/qaSafetyAdversarial.test.ts
git -c core.whitespace=cr-at-eol diff --check
git -c core.whitespace=cr-at-eol diff --check 40beff011cc6beef2407ba34a8606c1ba2fc85ac..HEAD
```

All four commands exited 0. Prettier reported all matched files formatted; ESLint had zero findings on both newly focused TypeScript files and the inherited adversarial TypeScript file. This integration report and the final committed diff receive a separate scoped Prettier/whitespace check before handoff.

## Cleanup and residual limits

- Copied generated inputs and card-owned browser screenshots were removed; the tracked `.eslintcache` was restored after the linter removed it. No generated test input or screenshot belongs to the candidate commit.
- All fixtures were synthetic/offline: disposable test keys, fake chain/provider adapters, temporary file-backed ledgers, loopback HTTP, and intercepted Chromium transport with virtual time. This is not evidence from operational wallets, funded coins, real signing, live maker/chain/provider/DNS, broadcasts, settlement, another browser, or deployment.
- Production HTTP timeout defaults were asserted, but timeout paths ran with shrunk QA-instance timers rather than a 10/15-second wall-clock soak.
- The strict-older guard covers decreasing producer timestamps. Equal timestamps retain prior replacement behavior and were not given a new contract; no-held-book behavior remains unchanged.
- Cross-process evidence covers local Windows filesystem behavior and compliant CLI entrants using replaced external adapters. It does not prove power-loss behavior, remote filesystem semantics, arbitrary external writers, sanitized executable stderr, real server admission, or operational signer behavior. The checked lock result is the `EEXIST` code; executable stderr can include a lock path.
- This report assembles and verifies an offline local candidate only. Manager review remains required; no push, deploy, live-trade, or release approval is implied.
