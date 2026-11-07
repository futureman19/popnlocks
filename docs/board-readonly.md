# Daily board (read-only increment)

`docs/index.html` remains a standalone page. No dependencies, bundling, wallet integration or transaction actions were added. The maker meta tag is intentionally empty: the shipped default is **Maker offline**, not a demonstration price feed. Configuring it never enables Take.

## Maker configuration

Set `<meta name="popnlocks-maker" content="https://your-maker.example">` to an operator-approved maker base URL. The page reads `/quotes` with no credentials, no referrer and no cache. Configure the maker's exact allowed CORS origin for the site or local server. HTTPS pages require an HTTPS maker. Never put secrets in the URL. Requests time out after 10 seconds; the next request starts 30 seconds after completion (no overlap or faster polling).

Only Daily (144 blocks) is displayed. Quote stakes are satoshis, not implied probability: maker `no` sells taker YES and maker `yes` sells taker NO. Winner payout subtracts three crank bounties; network fees are additional. Window countdown is in blocks from the maker-reported height, with a clearly labeled 10-minute/block estimate. A wall-clock deadline would be misleading. Quotes age out after 90 seconds even between polls. Stopped, stale, malformed, conflicting, expired and empty books suppress prices. Display parsing is not independent chain or cryptographic verification.

## History

The existing locksmith-owned `docs/data/pops.json` is read on served pages, using its actual `{marketId,market,txids,winnerSide}` records and linking the last txid. The newest six appended records appear first. The current empty array yields an honest empty state. File previews deliberately skip same-file JSON fetch (blocked by browser CORS) and state that history is unavailable. No historical records or sample quotes are deployed.

## Local verification

- `npm test`: existing contract/maker suite, unaffected.
- `python tests/board-browser.py`: optional Playwright browser check using an already-installed Python Playwright/Chromium, not a project dependency. Starts and closes its own localhost server. Exercises file and served pages at 390px, 22 isolated synthetic quote/history scenarios, disabled controls in live and dry-run modes, stake/side/payout math, stale timer, polling cadence, reduced motion, console/page errors, actual empty-history reads and unchanged Receipts markup. Generates root-level `board-*.png` evidence files (not site assets).
- Fixtures are intercepted in the test browser only. Offline fixture is a rejected fetch, not a claim that a real disconnected host avoids Chromium's network diagnostic. Existing Google font CSS is intercepted for deterministic offline testing.

## Explicitly deferred

Yours funding/signing adapter, independent quote/anchor/prevout authentication, advanced key flow, POST /take, broadcasting, Weekly market, live maker authorization and production deployment. No private key fields or wallet calls exist in this increment. Independent same-card review is required before acceptance.
