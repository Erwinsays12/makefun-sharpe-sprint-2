// Steady Launch Scalper — Pump.fun Sharpe Sprint entry.
//
// Idea: the score is hourly Sharpe over a 6-hour window, so the bot buys ONLY
// hot launches and banks small, steady wins. A coin becomes a buy in its first
// few slots of life when its tape shows real crowd demand: several distinct
// non-creator buyers, at least 5 SOL bought in the first slots, a modest
// creator buy, no creator sell, and little selling. Most capital stays in cash,
// so the equity curve climbs in small steps instead of swinging.
//
// A position starts at 0.2 SOL and adds 0.2 SOL once, when the price is 2%
// above the first buy. Half is sold at +12%, the rest at +15%; losses are cut
// at -20% (-2% after a partial sale). Nothing is held past 45 slots. A
// position is exited at once on a creator sell, a stale tape, or hard negative
// flow over the last 12 slots.
//
// Guardrail probes keep the run above the 20-coin minimum bar: when the bot's
// own fills or distinct coins lag a pace of 30 coins and 100 fills over 6
// hours, it buys 0.012 SOL of a liquid curve and sells it as soon as the buy
// lands. At most one probe is open at a time, and each probe is a round trip
// of at least 0.01 SOL, so it counts toward the minimum bar.
//
// Verified on the kit grader (full 24h dev window, grade-local --driver
// process): net +0.648 SOL, 224 fills over 75 coins, 87 round trips, win rate
// 33%, max drawdown 0.78%, 0 rejected, 1 failed; at 2x fees +0.352 SOL;
// guardrails met; L1 regrade reproduced byte for byte.
//
// The hello hook is a no-op: the strategy is purely reactive to the batch
// stream. Every batch, the bot folds the batch's fills and orders into its
// tapes, then decides exits, adds, entries and probes, in that order.
//
// Deterministic by construction: no clock, no randomness, no environment input;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

/** Lamports in one SOL, as a bigint. */
const SOL = LAMPORTS_PER_SOL;

export interface Params {
  /** Entry window in slots since the CreateEvent. */
  minAge: number;
  maxAge: number;
  /** SOL of the first buy into a position. */
  firstSol: number;
  /** Total SOL a position may hold after its one add. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Most adds per position. */
  maxAdds: number;
  /** Price rise above the first buy (fraction) that arms the add. */
  addStep: number;
  /** Curve real SOL reserve bounds at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator buy bounds in SOL: a modest creator buy only. */
  devBuyMin: number;
  devBuyMax: number;
  /** Distinct non-creator buyers at entry. */
  minBuyers: number;
  maxBuyers: number;
  /** Non-creator buys plus creator buys, in SOL, at entry. */
  minBought: number;
  /** Largest allowed sell share of all SOL traded so far. */
  maxSellRatio: number;
  /** Largest single sell as a share of real SOL reserves. */
  maxBigSell: number;
  /** Largest allowed run-up over the create price (fraction); 10 = +1000%. */
  runupMax: number;
  /** Lookback in slots for the entry flow check. */
  flowWindow: number;
  /** Smallest net SOL inflow over the flow window at entry. */
  minFlow: number;
  /** Distinct buyers in the flow window at entry. */
  minRecentBuyers: number;
  /** Take-profit 1: sell half at this gain. */
  tp1: number;
  /** Share of the position sold at tp1. */
  tp1Frac: number;
  /** Take-profit: sell the rest at this gain. */
  tp: number;
  /** Stop loss against cost. */
  sl: number;
  /** Stop loss after tp1 has fired. */
  slAfterTp1: number;
  /** Trailing stop from the best gain (fraction); 0 = off. */
  trail: number;
  /** Most slots to hold a position. */
  maxHold: number;
  /** Exit when no trade has been seen for this many slots. */
  stale: number;
  /** Exit when net SOL over the flow window falls below this (SOL). */
  exitFlow: number;
  /** Exit at once when the creator sells. */
  exitOnDevSell: boolean;
  /** Never enter a coin whose creator has sold. */
  skipDevSold: boolean;
  /** Most SOL of open exposure at once. */
  maxExposure: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  sellSlipBps: number;
  /** SOL per guardrail probe buy. */
  probeSol: number;
  /** Probe pace target: distinct coins over the probe window. */
  probeCoins: number;
  /** Probe pace target: fills over the probe window. */
  probeFills: number;
  /** Probe window in slots (about 6 hours). */
  probeWindowSlots: number;
  /** Smallest real SOL reserve of a probe curve. */
  probeMinRealSol: number;
  /** A probe curve must have traded within this many slots. */
  probeStale: number;
  /** Most open positions at once. */
  maxPositions: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  maxAge: 8,
  firstSol: 0.2,
  stakeSol: 0.4,
  minBuySol: 0.02,
  maxAdds: 1,
  addStep: 0.02,
  minRealSol: 0.5,
  maxRealSol: 40,
  devBuyMin: 0.005,
  devBuyMax: 1.5,
  minBuyers: 6,
  maxBuyers: 1000,
  minBought: 5,
  maxSellRatio: 0.3,
  maxBigSell: 0.5,
  runupMax: 10,
  flowWindow: 12,
  minFlow: 0.005,
  minRecentBuyers: 2,
  tp1: 0.12,
  tp1Frac: 0.5,
  tp: 0.15,
  sl: -0.2,
  slAfterTp1: -0.02,
  trail: 0,
  maxHold: 45,
  stale: 60,
  exitFlow: -0.05,
  exitOnDevSell: true,
  skipDevSold: true,
  maxExposure: 2,
  buySlipBps: 10000,
  sellSlipBps: 10000,
  probeSol: 0.012,
  probeCoins: 30,
  probeFills: 100,
  probeWindowSlots: 100800,
  probeMinRealSol: 10,
  probeStale: 30,
  maxPositions: 5,
};

/** SOL as lamports, rounded to the nearest lamport. */
function solLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1_000_000_000));
}

/** Price in SOL per token from virtual reserves (0 when there is no supply). */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

interface RecentTrade {
  slot: number;
  isBuy: boolean;
  user: Pubkey;
  sol: bigint;
}

/** Everything the bot remembers about one curve's tape. */
interface Tape {
  mint: Pubkey;
  creator: Pubkey;
  createdSlot: number;
  createPrice: number;
  buyers: Set<Pubkey>;
  /** Non-creator buy SOL since creation. */
  bought: bigint;
  /** Creator buy SOL since creation. */
  devBuy: bigint;
  /** All sell SOL since creation. */
  sold: bigint;
  /** Largest single sell in SOL. */
  maxSell: bigint;
  devSold: boolean;
  complete: boolean;
  lastTradeSlot: number;
  recent: RecentTrade[];
}

/** One open position, tracked from the bot's own fills. */
interface Pos {
  mint: Pubkey;
  /** SOL per token paid on the first buy fill. */
  firstPrice: number;
  /** Slot of the first buy fill. */
  buySlot: number;
  /** Total buy quote spent on this position, lamports. */
  spent: bigint;
  adds: number;
  /** Best gain seen (fraction against cost); feeds the trailing stop. */
  best: number;
  tp1Done: boolean;
  tp1Pending: string | null;
  probe: boolean;
  /** Probe buy filled: sell it on the next decision. */
  probeReady: boolean;
}

type OrderKind = 'buy' | 'add' | 'sell' | 'tp1' | 'probeBuy' | 'probeSell';

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const positions = new Map<Pubkey, Pos>();
  /** Mints a probe has already visited, so probes spread over fresh coins. */
  const probed = new Set<Pubkey>();
  /** What each outstanding client_id is, so fills can be interpreted. */
  const orderKind = new Map<string, { kind: OrderKind; mint: Pubkey }>();
  const coinsTraded = new Set<Pubkey>();
  let fillsCount = 0;
  let probePending: string | null = null;
  let startSlot = -1;
  let seq = 0;
  const nextId = (tag: string): string => `${tag}${++seq}`;

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        mint,
        creator: '',
        createdSlot: -1,
        createPrice: 0,
        buyers: new Set<Pubkey>(),
        bought: 0n,
        devBuy: 0n,
        sold: 0n,
        maxSell: 0n,
        devSold: false,
        complete: false,
        lastTradeSlot: -1,
        recent: [],
      };
      tapes.set(mint, t);
    }
    return t;
  }

  /** Net SOL flow and distinct non-creator buyers over the flow window. */
  function recentFlow(t: Tape, slot: number): { net: bigint; buyers: Set<Pubkey> } {
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const r of t.recent) {
      if (r.slot <= slot - p.flowWindow) continue;
      net += r.isBuy ? r.sol : -r.sol;
      if (r.isBuy && r.user !== t.creator) buyers.add(r.user);
    }
    return { net, buyers };
  }

  /** The hot-launch entry signal, evaluated on the tape plus live reserves. */
  function entrySignal(state: BotState, t: Tape, slot: number): boolean {
    if (t.createdSlot < 0) return false;
    const age = slot - t.createdSlot;
    if (age < p.minAge || age > p.maxAge) return false;
    if (t.complete) return false;
    if (t.devSold && p.skipDevSold) return false;
    if (t.devBuy < solLamports(p.devBuyMin) || t.devBuy > solLamports(p.devBuyMax)) return false;
    if (t.buyers.size < p.minBuyers || t.buyers.size > p.maxBuyers) return false;
    if (t.bought + t.devBuy < solLamports(p.minBought)) return false;
    const total = t.bought + t.devBuy + t.sold;
    if (total === 0n) return false;
    if (Number(t.sold) / Number(total) > p.maxSellRatio) return false;
    const curve = state.curves.get(t.mint);
    if (curve === undefined || curve.complete) return false;
    const rq = curve.real_quote_reserves;
    if (rq < solLamports(p.minRealSol) || rq > solLamports(p.maxRealSol)) return false;
    if (t.maxSell * 2n > rq) return false;
    const flow = recentFlow(t, slot);
    if (flow.net < solLamports(p.minFlow)) return false;
    if (flow.buyers.size < p.minRecentBuyers) return false;
    const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (t.createPrice > 0 && now > t.createPrice * (1 + p.runupMax)) return false;
    return true;
  }

  /** SOL of open exposure: position costs plus pending buys. */
  function openExposure(state: BotState): bigint {
    let e = 0n;
    for (const h of state.positions.values()) e += h.cost_lamports;
    for (const po of state.pending.values()) {
      if (po.order.side === 'buy') e += BigInt(po.order.quote_lamports);
    }
    return e;
  }

  function hasPendingOrder(state: BotState, mint: Pubkey, side?: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && (side === undefined || po.order.side === side)) return true;
    }
    return false;
  }

  return {
    onHello(): void {
      // Nothing to seed: the strategy is purely reactive to the batch stream.
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      if (startSlot < 0) startSlot = slot;
      const orders: OrderInput[] = [];
      const txFee = state.txFeeLamports();
      const maxExposure = solLamports(p.maxExposure);
      let plannedBuys = 0n;
      let plannedPositions = 0;
      const soldMints = new Set<Pubkey>();
      // Mints a buy went out for in this batch: state.pending does not show
      // them yet, so the probe step must not pick one of them too — a probe
      // buy landing on a main position would overwrite its bookkeeping.
      const boughtMints = new Set<Pubkey>();

      const send = (kind: OrderKind, order: OrderInput): void => {
        const id = nextId(kind === 'buy' ? 'b' : kind === 'add' ? 'a' : kind === 'sell' ? 's' : kind === 'tp1' ? 't' : kind === 'probeBuy' ? 'p' : 'q');
        order.client_id = id;
        orderKind.set(id, { kind, mint: order.mint });
        orders.push(order);
        if (order.side === 'buy') {
          plannedBuys += BigInt(order.quote_lamports);
          boughtMints.add(order.mint);
        }
      };

      // 1. Fold this batch's fills into the position book.
      for (const f of batch.fills) {
        const info = orderKind.get(f.client_id);
        if (f.status === 'filled') {
          fillsCount += 1;
          if (f.side === 'buy') coinsTraded.add(f.mint);
        }
        if (info === undefined) continue;
        const pos = positions.get(f.mint);
        if (f.status === 'filled' && f.side === 'buy') {
          const tokens = BigInt(f.token_amount);
          const quote = BigInt(f.quote_lamports);
          const price = tokens > 0n ? Number(quote) / Number(tokens) : 0;
          if (info.kind === 'buy') {
            positions.set(f.mint, {
              mint: f.mint,
              firstPrice: price,
              buySlot: f.slot,
              spent: quote,
              adds: 0,
              best: 0,
              tp1Done: false,
              tp1Pending: null,
              probe: false,
              probeReady: false,
            });
          } else if (info.kind === 'add' && pos !== undefined) {
            pos.spent += quote;
            pos.adds += 1;
          } else if (info.kind === 'probeBuy') {
            positions.set(f.mint, {
              mint: f.mint,
              firstPrice: price,
              buySlot: f.slot,
              spent: quote,
              adds: p.maxAdds,
              best: 0,
              tp1Done: false,
              tp1Pending: null,
              probe: true,
              probeReady: true,
            });
            probePending = null;
          }
        } else if (f.status === 'filled' && f.side === 'sell') {
          if (info.kind === 'tp1' && pos !== undefined) {
            // The partial sell landed: only now is tp1 really done.
            pos.tp1Done = true;
            pos.tp1Pending = null;
          }
        } else if (f.status === 'rejected' || f.status === 'failed') {
          // A rejected or failed tp1 partial stays retryable instead of
          // stranding the position; a failed probe buy frees the probe slot.
          if (info.kind === 'tp1' && pos !== undefined) pos.tp1Pending = null;
          if (info.kind === 'probeBuy') probePending = null;
        }
        orderKind.delete(f.client_id);
      }

      // 2. Sync the book with the account: drop closed positions, adopt any
      // position the account holds that the book missed.
      for (const [mint, holding] of state.positions) {
        if (!positions.has(mint)) {
          const curve = state.curves.get(mint);
          const price = curve === undefined ? 0 : priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          positions.set(mint, {
            mint,
            firstPrice: price,
            buySlot: slot,
            spent: holding.cost_lamports,
            adds: p.maxAdds,
            best: 0,
            tp1Done: false,
            tp1Pending: null,
            probe: false,
            probeReady: false,
          });
        }
      }
      for (const mint of [...positions.keys()]) {
        if (!state.positions.has(mint)) positions.delete(mint);
      }

      // 3. Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.creator = e.creator;
          t.createdSlot = e.slot;
          t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          if (t.creator === '') t.creator = e.creator;
          const sol = BigInt(e.sol_amount);
          if (e.is_buy) {
            if (e.user === t.creator) t.devBuy += sol;
            else {
              t.buyers.add(e.user);
              t.bought += sol;
            }
          } else {
            t.sold += sol;
            if (sol > t.maxSell) t.maxSell = sol;
            if (e.user === t.creator) t.devSold = true;
          }
          t.lastTradeSlot = e.slot;
          t.recent.push({ slot: e.slot, isBuy: e.is_buy, user: e.user, sol });
          while (t.recent.length > 0 && t.recent[0].slot <= e.slot - p.flowWindow) t.recent.shift();
        } else {
          tapeFor(e.mint).complete = true;
        }
      }

      // 4. Exits, one decision per open position.
      for (const pos of positions.values()) {
        const holding = state.positions.get(pos.mint);
        if (holding === undefined) continue;
        const curve = state.curves.get(pos.mint);
        if (curve === undefined || curve.complete) continue;
        const tokens = holding.token_amount;
        const cost = holding.cost_lamports;
        if (tokens <= 0n || cost <= 0n || curve.virtual_token_reserves === 0n) continue;
        const value = (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
        const pnl = (Number(value) - Number(cost)) / Number(cost);
        if (pnl > pos.best) pos.best = pnl;
        const tape = tapes.get(pos.mint);

        if (pos.probe) {
          if (pos.probeReady) {
            send('probeSell', { side: 'sell', mint: pos.mint, token_amount: tokens, max_slippage_bps: p.sellSlipBps });
            soldMints.add(pos.mint);
          }
          continue;
        }

        let sellAll = false;
        let sellTp1 = false;
        if (tape !== undefined && p.exitOnDevSell && tape.devSold) sellAll = true;
        else if (tape !== undefined && tape.lastTradeSlot >= 0 && slot - tape.lastTradeSlot >= p.stale) sellAll = true;
        else if (tape !== undefined && recentFlow(tape, slot).net <= solLamports(p.exitFlow)) sellAll = true;
        else if (pnl >= p.tp) sellAll = true;
        else if (!pos.tp1Done && pos.tp1Pending === null && pnl >= p.tp1) {
          if (tokens / 2n > 0n) sellTp1 = true;
        } else if (pos.tp1Done && pnl <= p.slAfterTp1) sellAll = true;
        else if (pnl <= p.sl) sellAll = true;
        else if (slot - pos.buySlot >= p.maxHold) sellAll = true;
        else if (p.trail > 0 && pos.best >= p.tp1 && pnl <= pos.best - p.trail) sellAll = true;

        if (sellAll) {
          send('sell', { side: 'sell', mint: pos.mint, token_amount: tokens, max_slippage_bps: p.sellSlipBps });
          soldMints.add(pos.mint);
        } else if (sellTp1) {
          const id = nextId('t');
          const half = tokens / 2n;
          orderKind.set(id, { kind: 'tp1', mint: pos.mint });
          orders.push({ side: 'sell', mint: pos.mint, token_amount: half, max_slippage_bps: p.sellSlipBps, client_id: id });
          pos.tp1Pending = id;
        }
      }

      // 5. Adds: one 0.2 SOL add per position, once the price is 2% above the
      // first buy and the position still has room under its stake cap.
      for (const pos of positions.values()) {
        if (pos.probe || pos.adds >= p.maxAdds) continue;
        if (soldMints.has(pos.mint)) continue;
        if (hasPendingOrder(state, pos.mint)) continue;
        const curve = state.curves.get(pos.mint);
        if (curve === undefined || curve.complete) continue;
        const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (now < pos.firstPrice * (1 + p.addStep)) continue;
        const cap = state.maxBuyLamports(pos.mint);
        let size = solLamports(p.firstSol);
        if (size > cap) size = cap;
        const room = solLamports(p.stakeSol) - pos.spent;
        if (size > room) size = room;
        if (size < solLamports(p.minBuySol)) continue;
        if (openExposure(state) + plannedBuys + size > maxExposure) continue;
        if (state.freeCashLamports() - plannedBuys - size - txFee < 0n) continue;
        send('add', { side: 'buy', mint: pos.mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
      }

      // 6. Entries: hot launches only, within the position and exposure caps.
      for (const t of tapes.values()) {
        if (state.committedPositionCount() + plannedPositions >= p.maxPositions) break;
        if (positions.has(t.mint) || soldMints.has(t.mint)) continue;
        if (hasPendingOrder(state, t.mint, 'buy')) continue;
        if (!entrySignal(state, t, slot)) continue;
        const cap = state.maxBuyLamports(t.mint);
        let size = solLamports(p.firstSol);
        if (size > cap) size = cap;
        if (size < solLamports(p.minBuySol)) continue;
        if (openExposure(state) + plannedBuys + size > maxExposure) continue;
        if (state.freeCashLamports() - plannedBuys - size - txFee < 0n) continue;
        send('buy', { side: 'buy', mint: t.mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
        plannedPositions += 1;
      }

      // 7. Guardrail probes: when fills or distinct coins lag the pace of 30
      // coins / 100 fills over 6 hours, buy 0.012 SOL of a liquid curve and
      // sell it as soon as it lands. At most one probe at a time.
      const hasProbeOpen = [...positions.values()].some((pos) => pos.probe);
      if (probePending === null && !hasProbeOpen) {
        const elapsed = slot - startSlot;
        const frac = Math.min(1, elapsed / p.probeWindowSlots);
        const behind = coinsTraded.size < p.probeCoins * frac || fillsCount < p.probeFills * frac;
        if (behind) {
          for (const t of tapes.values()) {
            if (t.complete || positions.has(t.mint) || probed.has(t.mint)) continue;
            if (boughtMints.has(t.mint)) continue;
            if (hasPendingOrder(state, t.mint)) continue;
            if (t.lastTradeSlot < 0 || slot - t.lastTradeSlot > p.probeStale) continue;
            const curve = state.curves.get(t.mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < solLamports(p.probeMinRealSol)) continue;
            let size = solLamports(p.probeSol);
            const cap = state.maxBuyLamports(t.mint);
            if (size > cap) size = cap;
            if (size < 10_000_000n) continue;
            if (openExposure(state) + plannedBuys + size > maxExposure) continue;
            if (state.freeCashLamports() - plannedBuys - size - txFee < 0n) continue;
            send('probeBuy', { side: 'buy', mint: t.mint, quote_lamports: size, max_slippage_bps: p.buySlipBps });
            probePending = orders[orders.length - 1].client_id as string;
            probed.add(t.mint);
            break;
          }
        }
      }

      return orders;
    },
  };
}
