# Steady Launch Scalper — Pump.fun Sharpe Sprint

[![make.fun bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Erwinsays12/makefun-sharpe-sprint-2/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Erwinsays12/makefun-sharpe-sprint-2/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Entry for [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun. Paper trading only — the bot trades on a 6-hour pump.fun replay, ranked by hourly Sharpe ratio.

## Strategy

The score is hourly Sharpe, not PnL, so the bot buys only hot launches and banks small, steady wins:

- **Entry:** coins 1–8 slots old with at least 6 distinct non-creator buyers, at least 5 SOL bought in the first slots, a modest creator buy (0.005–1.5 SOL), no creator sell, and little selling (sell share ≤ 30%, largest single sell ≤ 50% of real reserves).
- **Size:** 0.2 SOL first buy, one 0.2 SOL add when the price is 2% above the first buy. Max 5 positions, max 2 SOL exposure — most capital stays in cash.
- **Exits:** half sold at +12%, the rest at +15%; losses cut at −20% (−2% after a partial sale). Never held past 45 slots. Immediate exit on a creator sell, a stale tape (60 slots), or hard negative flow (−0.05 SOL over 12 slots).
- **Guardrail probes:** tiny 0.012 SOL round trips on liquid curves, paced to 30 coins / 100 fills over 6 hours, keep the run above the 20-coin minimum bar. At most one probe at a time.

## Dev-window results (kit grader, full 24h dev dataset)

- Net **+0.648 SOL** (90% interval +0.23…+1.08 SOL), 224 fills, 75 coins, 87 round trips, win rate 33%, max drawdown 0.78%, 0 rejected, guardrails met.
- At 2x fees: +0.352 SOL. Four standalone 6h slices all net positive.
- Deterministic: regrade reproduces byte for byte.

## Files

- `main.ts` — entrypoint; wires the strategy into the make.fun SDK.
- `strategy.ts` — the Steady Launch Scalper (parameters in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `.makefun/owner.json` — the entry's payout wallet.

## License

MIT — see `LICENSE`.
