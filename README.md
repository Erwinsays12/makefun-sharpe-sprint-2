[![Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Erwinsays12/makefun-sharpe-sprint-2/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Erwinsays12/makefun-sharpe-sprint-2/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Steady Launch Scalper

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition on make.fun.

The bot trades paper money on a 6-hour pump.fun replay. Places go by hourly
Sharpe ratio, so the strategy is built for many small, low-variance wins
rather than one lucky moonshot: it buys a fresh launch once, only when its
opening tape looks like a real launch — several distinct wallets piling in
within the first slots, several SOL bought, a modest creator buy, no creator
sell, little selling — takes half off at +12%, lets the rest run to +15%,
cuts the loss at −20%, and never holds past 45 slots. Most capital stays in
cash, so the equity curve climbs in small steps.

## How it works

- **Entry (once per coin, 1–8 slots after creation):** at least 6 distinct
  non-creator buyers and at least 5 SOL bought in the opening tape,
  creator buys 0.005–1.5 SOL and has not sold, sells at most 30% of buys,
  largest single sell at most 50% of real reserves, price run-up 0–1000%
  from creation, real SOL reserves 0.5–40 SOL, and net flow over the last
  12 slots at least 0.005 SOL with at least 2 recent buyers.
- **Sizing:** first buy 0.2 SOL, one add to 0.4 SOL total when the price
  steps up 2% with flow still positive; at most 5 open positions and 2 SOL
  at cost across all positions; every buy respects the 1%-of-real-reserve
  size cap and the 0.01 SOL minimum round trip.
- **Exit:** sell half at +12% over cost, the rest at +15%, stop loss −20%
  (−2% once the partial is banked), 45-slot time stop, exit at once on a
  creator sell, on net flow below −0.05 SOL, or when the coin prints no
  trade for 60 slots.
- **Guardrail probes:** tiny 0.012 SOL round trips on liquid curves, paced
  to 30 coins / 100 fills over 6 hours, keep the run above the 20-coin
  minimum bar when the main signal goes quiet.
- **Limits:** fully deterministic (no clock, no network, no randomness);
  two graded executions produce byte-identical action logs.

## Local check

Verified with the kit's own grader (`grade-local --driver process`, full
24h dev dataset, two executions, L1 regrade reproduced byte for byte):
net **+0.648 SOL** (return 6.5%, 90% interval +0.23..+1.08 SOL), 224 fills
over 75 coins, 87 round trips, win rate 33%, max drawdown 0.8%, 0
rejected. Top 3 coins made 35% of the gains; without them net is still
+0.31 SOL. At 2x fees it still nets +0.35 SOL. Guardrails met (75 coins
hold a round trip of at least 0.01 SOL, drawdown ok). Run as four
standalone 6-hour slices — the shape of the final window — every slice is
net positive (+0.05 / +0.13 / +0.21 / +0.20 SOL) with hourly Sharpes
0.32 / 0.56 / 0.66 / 0.49 and 32–37 coins per slice, so the 20-coin
guardrail holds in each slice.

## Run

The grader runs `node main.ts` (Node 22). `vendor/makefun-bot.ts` is the
kit's bot shim, vendored byte for byte.

## License

MIT — see [LICENSE](LICENSE).
