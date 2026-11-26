# Maker lock-conflict stderr privacy

The sixth ownership test runs the real `maker/cli.ts --live` entry point against a fresh synthetic config while the parent holds the same directory's lock. The child receives the existing offline environment allowlist, not the parent's credentials. Its stdout and stderr are captured separately.

| Focused run                                    | Result             | Executable observation                                                                                                                                           |
| ---------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before the fix, on `791b1e1` with the new test | 5 passed, 1 failed | Exit 1, empty stdout. The stderr assertion received `EEXIST: file already exists, open '<synthetic state directory>/maker.lock'` plus a newline (path redacted). |
| After the fix                                  | 6 passed           | Exit 1, empty stdout, stderr exactly `MAKER_ALREADY_RUNNING\n` (one LF). No hold file appeared; the parent's lock remained until fixture cleanup.                |

Only an exclusive lock open that fails with `EEXIST` gets the generic message. Imported callers retain the error code; unrelated errors are rethrown unchanged. The lock mode, cleanup registration, and order of startup checks did not change.

Reproduce with `NETWORK=local`, `npm_config_offline=true`, `PRIVATE_KEY` unset, and the existing generated contract inputs:

```sh
node "$MOCHA" --no-config --no-package --require ts-node/register --timeout 3000 tests/qaReservationOwnership.test.ts
```

`MOCHA` denotes the repository's installed `mocha/bin/mocha.js`. This is an offline lock-contention check, not a privacy claim for other failures or a live signing or deployment test.
