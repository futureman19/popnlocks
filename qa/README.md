# Live maker board verification

Run `python qa/live-quotes.py` from the repository root with Python Playwright and local Chrome installed. This QA-only tool is not a site dependency or build step. It serves the actual `docs/` page locally, redirects only the configured maker `/quotes` request to a local HTTP mock, and blocks all other external requests. Fixtures never enter `docs/`.

## Verified

- `npm test`: **62 tests passing**, zero failing; both covenant artifacts compiled successfully. Existing maker tests included.
- `npm run typecheck:maker`: passed.
- `git -c core.whitespace=cr-at-eol diff --check`: passed.
- Browser run: **11 scenarios passed**, zero uncaught page errors.
- `docs/data/pops.json`, settlement-history markup, and settlement-history script are unchanged.
- Display-only: Take controls remain disabled in every state. No signing, wallet, POST, or broadcast code added. No push or deployment performed.

## Per-state evidence

`evidence/results.json` contains actual DOM text and passed assertions. PNGs show the locally served page with synthetic mock quotes.

| State                    | Evidence                       | Assertions                                                                                                                                                            |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live                     | `evidence/live.png`            | YES/NO mapping; actual stakes 5,201 / 5,802 sats; net winner payout 9,697 sats after 303 bounty sats; expiry height 1,008,013 and estimated 30 minutes; Take disabled |
| Dry-run                  | `evidence/dry-run.png`         | Prominent `DRY-RUN — quotes not takable` banner; same exact amounts; Take disabled                                                                                    |
| Stopped                  | `evidence/stopped.png`         | `book stopped`; prices removed; Take disabled                                                                                                                         |
| Wall-clock stale         | `evidence/stale.png`           | 91-second-old snapshot with producer stale=false is rejected; `quotes stale`; prices removed                                                                          |
| Offline                  | `evidence/offline.png`         | HTTP 503 gives `maker offline — showing settled markets only`; settled history still loads                                                                            |
| Non-JSON                 | `evidence/non-json.png`        | HTML response uses offline fallback without crashing history                                                                                                          |
| Producer stale           | `evidence/stale-flag.png`      | Fresh timestamp with stale=true is rejected                                                                                                                           |
| Combined dry-run/stopped | `evidence/dry-run-stopped.png` | Dry-run badge persists alongside stopped state                                                                                                                        |

Additional assertions: a snapshot initially 89 seconds old expires locally without another fetch; real browser timers poll at 20 seconds and pause across a simulated hidden visibility event, then resume immediately; 390px layout has no horizontal overflow. Visibility was simulated through the document property/event, not a claim of OS tab-switch testing.

## Implementation notes

The starting page already had a disconnected read-only quote card above Recent pops. This change connects and updates that card rather than adding a duplicate board. `MAKER_BASE_URL` is the sole maker configuration; its default is the future public endpoint. Expiry time is explicitly an estimate because the contract supplies block heights, not a timestamp. Freshness uses the producer's original `refreshedAt`, never the fetch time, with a deadline timer and visibility-resume age check. Quote IDs follow the schema's trimmed 1–128-character contract, not a narrower hex-only assumption.

## Verification caveats resolved

The first dependency install skipped lifecycle scripts, so the sCrypt transformer was not initialized and compilation reported a missing artifacts directory. `npm rebuild` restored normal dependency setup; the subsequent unmodified `npm test` passed. No build-source workaround was applied.

Two QA harness assumptions were corrected: installing virtual time after page timers did not control those timers, and freezing the clock interfered with timestamp/RAF waits. The final cadence test uses real elapsed time instead. These were harness failures, not product defects; final evidence was regenerated after HTML formatting.
