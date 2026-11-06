# popnlocks: the chain settles its own bets

_POP-0 ran on Bitcoin mainnet on 2026-11-06. Five transactions, one covenant, zero oracles._

## The oracle is the thing being predicted

Every prediction market has the same soft underbelly: settlement. Somebody — a reporter, a committee, a token vote — has to look at the world and say what happened, and that somebody can be wrong, bribed, or slow. Entire protocols exist to wrap this in incentives and dispute windows.

Hashrate derivatives have it worse. They exist today only off-chain (Luxor's Hashprice contracts, BitOoda), settled by the desk that sells them. The one market where miners could hedge their single largest risk — future difficulty — runs on trust.

Here is the inversion at the heart of popnlocks: **the data that settles a difficulty market is produced by the same proof-of-work the market is pricing.** Every block header carries a `bits` field — the difficulty target its miner had to meet. To forge settlement data you would have to mine thousands of fake blocks at fabricated difficulties. The cost of lying is the cost of the work itself. That is not an oracle. That is physics.

## The mechanism

A binary market asks: _will consensus difficulty be at or above strike K at the end of the window?_

1. **LOCK** — YES and NO collateral funds a covenant (an sCrypt contract) anchored to a past block. The strike is compiled into the script.
2. **CRANK** — settlement is anyone-callable. Each call presents a chunk of real block headers; the covenant verifies hash-linkage, recomputes each block's hash and checks it against `bits`, enforces a per-header drift bound (±5%) plus an anchor-relative floor, and carries its position forward in a continuation output. Every crank pays a bounty to whoever submitted it — these keepers are _locksmiths_.
3. **POP** — the final crank reads the difficulty target at the endpoint header, compares it to the strike, and the covenant pays the winner. No signature on the outcome. No one decides. The lock pops.

Script has no loops, so verification runs as a ladder of cranks rather than one megatransaction. The covenant is the sole authority on payouts — the contract recomputes and asserts its own outputs in-script; a client-side builder that disagrees simply fails.

## The proof

POP-0, the reference market, ran end-to-end on BSV mainnet: a retro market over sixteen headers following block 830000, strike set at the real endpoint target.

- Deploy `ca36664a…28145ea` → three cranks → settle `92c3d27c…2f54b3d8`
- All five transactions mined in **block 974267**
- YES was paid 900 sats, the locksmith collected 100 sats — enforced entirely in-covenant
- Total cost: about $0.003 in fees

Every step is checkable against your own node. The spec ([POP-0](POP-0-binary-difficulty-market.md)) carries the full transaction list, and the repo's test suite replays the golden chain plus synthetic attack chains (tampered headers, drift violations, floor breaches — all rejected).

## The honest limits

- **Lite DAA tier.** The contract bounds per-header drift and breach depth rather than recomputing the full 144-block retarget rule in-script. Residual manipulation room is priced, not eliminated: cap pots at 1–5% of what re-mining the window would cost.
- **Liveness.** Anyone _can_ crank, but someone _must_. The bounty market plus the winner's incentive to self-crank covers this economically, not magically.
- **Ops reality.** Mempool ancestor limits cap unconfirmed ladders at ~3 links; production markets (a full 2016-block epoch in 144-header chunks, ~14 cranks) will pace themselves against blocks. And a footnote for fellow builders: a popular tooling default pays 1 sat/KB, which no miner will ever see — check your fee floor.

## What's next

- **Production geometry** — full difficulty-epoch windows (2016 blocks), 144-header chunks, sized bounties.
- **The locksmith board** — a standing market of anyone-callable crank jobs: the first native paying gig for agents on-chain.
- **Linear payoffs** — binary is the floor; the ladder generalizes.

The chain attests to its own vital signs. The winner pops the lock.

---

_Spec: [POP-0](POP-0-binary-difficulty-market.md) · Site: [popnlocks.com](https://popnlocks.com) · Repo: [github.com/futureman19/popnlocks](https://github.com/futureman19/popnlocks)_
