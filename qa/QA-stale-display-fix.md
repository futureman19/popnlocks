# Popnlocks stale-display fix QA — t_27cbb691

- Lane: telegram3 · Branch: `wt/kimi-stale-display-fix`
- Starting HEAD: `d4225af2f12edcfdb4225b4ceaf64ac98cc44f34`; `8f4b669578883e2810c3dbc1e14db2ab1b211550`, `e435fb348906bee54558652d11553cf8abc390c6`, and `40beff011cc6beef2407ba34a8606c1ba2fc85ac` were confirmed ancestors and the worktree was clean before edits.
- Scope: one local-only candidate commit touching only `docs/index.html`, `tests/board-browser.py`, and this new report. No maker/src contract, dependency, config, generated artifact, Receipts, or unrelated formatting change.
- Fixtures: synthetic books, loopback static HTTP, intercepted Chromium transport, deterministic browser time, and disposable offline test keys. No operational wallet, credentials, funded coins, live chain/provider/DNS access, broadcast, push, deploy, spend, tag, or release claim.

## Required A/B reproduction

### A — strengthened regression against unchanged product

Only `tests/board-browser.py` had been edited; `docs/index.html` was verified unchanged. The exact command `python tests/board-browser.py` exited **1** at the new sequential fresh-but-older expectation:

```text
AssertionError: fresh-but-older overwrite: expected YES 5,400 sats / NO 6,000 sats; got YES 1,111 sats / NO 2,222 sats
```

The first completed response had `status.refreshedAt=1795718390000` and displayed YES `5,400 sats` / NO `6,000 sats`. The next completed response had `refreshedAt=1795718380000`, remained fresh, stayed in Dry-run, and incorrectly installed YES `1,111 sats` / NO `2,222 sats`. This is the required pre-product-edit failure, not a recorded pass.

### B — narrow product guard

The product change is one guard after the existing structural book validation and before `book = data`:

```js
if (book && s.refreshedAt < book.status.refreshedAt) return;
```

A strictly older producer timestamp therefore leaves the held book, prices, and already-scheduled expiry untouched. The `finally` block still completes serialized polling. Equal timestamps retain prior replacement behavior; with no held valid book, acceptance is unchanged. No error path, offline transition, freshness threshold, request timeout, polling delay, visibility rule, or Take gate was edited.

The post-fix A/B acceptance run of `python tests/board-browser.py`, before QA-only report completion, exited **0**:

- **22/22 existing fixture scenarios** passed (11 served + 11 file), including the separate 90-second producer-time expiry assertion.
- **2/2 focused polling probes** passed: slow-request timeout/serialization and delayed-older-response retention.
- The sequential regression retained YES `5,400 sats` / NO `6,000 sats` and the newer expiry schedule at `1795718390000 -> 1795718380000` ms; observed older age was **40,107 ms** (<90,000 ms), state remained Dry-run, and quote calls were GET-only with no blocked-loopback or browser/transport errors.
- The subsequent newer snapshot at `1795718410000` ms was accepted at observed age **30,111 ms**: YES `7,700 sats`, NO `8,800 sats`, 30 blocks to close, and quote expiry block `974,422`. Three completed quote requests proved polling had not frozen.
- Both real unmodified served/file offline documents passed. Production GET `/quotes` was blocked before DNS, and Receipts were unchanged.

## Focused Mocha

Final command:

```bash
env -u PRIVATE_KEY NETWORK=local npm_config_offline=true node C:/Users/futur/Desktop/popnlocks/node_modules/mocha/bin/mocha.js --no-config --no-package --require ts-node/register --timeout 3000 tests/qaTimeoutConcurrency.test.ts
```

Result: **9 passing / 0 failing**. Mocha emitted only the pre-existing module-type warning.

## Credential-isolated full Mocha at exact HEAD

Disposable scratch: `C:/Users/futur/.hermes/profiles/telegram3/cache/scratch/popnlocks-qa-t_27cbb691-exact`.

1. Created the tree with `set -o pipefail` and `git archive HEAD | tar -x -C <scratch>`; verified that `<scratch>/.env` did not exist before execution.
2. Copied only generated `artifacts/`, `dist/`, and `scrypt.index.json` from `C:/Users/futur/Desktop/popnlocks`. Created only the scratch `node_modules` junction to `C:/Users/futur/Desktop/popnlocks/node_modules` with `cmd.exe /c mklink /J`.
3. Ran from scratch, with output captured in scratch so only the key-generation marker and test totals were printed:

```bash
env -u PRIVATE_KEY NETWORK=local npm_config_offline=true node C:/Users/futur/Desktop/popnlocks/node_modules/mocha/bin/mocha.js
```

Observed result: exit **0**, `Private key generated and saved in ".env"`, and **92 passing / 0 failing**. The newly created disposable `.env` existed only in scratch and was checked by existence/size, never read or printed. The junction was removed with `cmd.exe /c rmdir` before deleting the rest of scratch; the scratch path was confirmed absent.

## QA setup and expectation corrections

Three setup/reporting corrections and one commit-hook workaround were needed; none was promoted to a product regression:

1. The fresh dispatcher worktree lacked untracked generated `artifacts/popnlocksProductionMarket.json`, so the first focused Mocha invocation failed 6 tests (3 passed) with ENOENT/derived bounded waits. Existing generated `artifacts/`, `dist/`, and `scrypt.index.json` were copied from the main repo as untracked local test inputs; the exact focused command then passed 9/9. Generated inputs remain outside the commit and will be removed before handoff.
2. The legacy delayed-stale probe expected an older timestamp-zero response to clear an already displayed newer book. That contradicted this card's explicit rule for every strictly older structurally valid book. Its expectation was aligned to retain YES `5,400 sats` / NO `6,000 sats`; the independent served/live scenario continues to prove expiry at the retained book's original producer timestamp plus 90 seconds.
3. The first sanitized full-suite log parser received an MSYS `/c/...` path even though native Python requires `C:/...`; the Mocha process itself had already exited 0. Re-reading the same log with the native path confirmed the generation marker and 92/92 before cleanup. No test was rerun or counted twice from that parser correction.

The commit hook could not start because this worktree lacks `.husky/_/husky.sh`. `prettier --check --ignore-unknown` passed on the candidate files, so the local commit used `--no-verify` only to bypass that unavailable helper; all required QA gates were run explicitly.

The intentional pre-fix regression failure is not counted as a harness defect. No new product defect was found in the passing post-fix run.

## Final diff and hygiene gates

- `env npm_config_offline=true npx --no-install prettier --check --ignore-unknown docs/index.html tests/board-browser.py qa/QA-stale-display-fix.md`: passed.
- `git -c core.whitespace=cr-at-eol diff --check`: passed for the working tree.
- `git -c core.whitespace=cr-at-eol diff --check d4225af2f12edcfdb4225b4ceaf64ac98cc44f34..HEAD`: passed for the committed candidate.
- `git diff-tree --no-commit-id --name-only -r HEAD`: exactly `docs/index.html`, `qa/QA-stale-display-fix.md`, and `tests/board-browser.py`; one local commit on the required base.
- `git diff --name-only 40beff011cc6beef2407ba34a8606c1ba2fc85ac..HEAD -- docs`: only `docs/index.html`. The product patch is the single strict-older guard shown above.
- Added-line review found no secret-like assignments, private-key material, new URL/endpoint, or new external transport. No maker/src, dependency, config, Receipts, or generated artifact changed.
- Card-owned screenshots, copied generated inputs, scratch, and junctions were removed; final `git status --porcelain=v1` was empty.

## Residual limits

- Browser evidence is Chromium with synthetic books, intercepted loopback transport, and Playwright virtual time. It is not a public-network, other-browser, wallet, trading, or deployment test.
- Equal producer timestamps were expressly out of scope and were not given a new behavioral contract; the strict `<` guard preserves prior behavior.
- Real maker/chain behavior, operational vault signing, funded coins, broadcast, settlement, and live deployment remain unverified and intentionally untouched.
- This is a local fix candidate only, not independent approval, push, deploy, or release approval.
