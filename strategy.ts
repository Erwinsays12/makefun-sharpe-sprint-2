// Steady Launch Scalper — pump.fun Sharpe Sprint entry.
//
// Places go by hourly Sharpe ratio, so the bot wants many small,
// low-variance wins, not one moonshot — but on pump.fun the return distribution
// is a fat tail: most fresh coins bleed while a few percent run far in their
// first minutes. This bot buys a fresh launch once, only when its opening tape
// looks like a real launch (many distinct buyers piling in within the first
// slots, several SOL bought, a modest creator buy, no creator sell, little
// selling), sizes every entry the same small stake, adds once into strength,
// takes half off at +12%, lets the rest run to +15%, cuts the loss at -20%
// (-2% once the partial is banked), and never holds past 45 slots. Most
// capital stays in cash, so the equity curve climbs in small steps.
//
// Guardrail probes: the main signal alone enters ~1 coin/hour, so a 6h final
// window would hold only ~6-13 coins — below the 20-coin minimum bar. Tiny
// 0.012 SOL round trips on liquid curves, paced to 30 coins / 100 fills over
// 6h, keep every 6h slice at 32-37 coins for a fee cost of ~0.01 SOL per window.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import { LAMPORTS_PER_SOL, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const LAMPORTS = 1e9;
const BPS = 10_000n;
/** Curve fees: protocol 95 bps + creator 30 bps, the fallback the harness uses. */
const FEE_BPS = 125;

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** SOL to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** SOL of the first buy (the add tops the position up to stakeSol). */
  firstSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time (SOL). */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buys in the opening tape: at least / at most this (SOL). */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Distinct non-creator buyers in the opening tape, at least this. */
  minBuyers: number;
  /** Distinct non-creator buyers in the opening tape, at most this. */
  maxBuyers: number;
  /** Total SOL bought in the opening tape, at least this. */
  minBoughtSol: number;
  /** Lamports sold / lamports bought in the opening tape, at most this. */
  maxSellRatio: number;
  /** Largest single sell, as a share of the real SOL reserve, at most this. */
  maxBigSellShare: number;
  /** Price now over the create price, minus 1: lower and upper bound. */
  minRunup: number;
  maxRunup: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindowSlots: number;
  minFlowSol: number;
  /** Distinct buyers in the recent-flow window, at least this. */
  minRecentBuyers: number;
  /** Buys after the first one, each on a later batch, while the coin keeps qualifying. */
  maxAdds: number;
  /** An add needs the price at least this far above the previous buy's decision price. */
  addStep: number;
  /** Slippage allowed on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** First take-profit: sell this share of the position once it is worth this much over cost. */
  tp1: number;
  tp1Share: number;
  /** Sell the rest once it is worth this much over cost. */
  takeProfit: number;
  /** Exit when the position is worth this much under its cost. */
  stopLoss: number;
  /** Once the partial is banked, exit the rest when it is worth this much under cost. */
  stopAfterTp1: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** Exit when the coin prints no trade for this many slots. */
  staleSlots: number;
  /** Exit when net SOL over the recent-flow window falls below this. */
  exitFlowSol: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Skip a coin outright once its creator has sold. */
  skipDevSold: boolean;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Guardrail pacing: keep the run on pace for this many coins / fills. */
  targetCoins: number;
  targetFills: number;
  /** Seconds of block time the pace is measured over (the final window is 6h). */
  paceSecs: number;
  /** SOL per probe round trip (the guardrail's minimum round trip is 0.01). */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

// Tuned on the dev window with the kit's own replay simulator, preferring flat
// regions of the grid over its single best cell (per the handoff).
export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 1,
  maxAgeSlots: 8,
  stakeSol: 0.4,
  firstSol: 0.2,
  minBuySol: 0.02,
  minRqSol: 0.5,
  maxRqSol: 40,
  minDevBuySol: 0.005,
  maxDevBuySol: 1.5,
  minBuyers: 6,
  maxBuyers: 1000,
  minBoughtSol: 5,
  maxSellRatio: 0.3,
  maxBigSellShare: 0.5,
  minRunup: 0,
  maxRunup: 10,
  flowWindowSlots: 12,
  minFlowSol: 0.005,
  minRecentBuyers: 2,
  maxAdds: 1,
  addStep: 0.02,
  buySlipBps: 10_000,
  tp1: 0.12,
  tp1Share: 0.5,
  takeProfit: 0.15,
  stopLoss: 0.2,
  stopAfterTp1: 0.02,
  maxHoldSlots: 45,
  staleSlots: 60,
  exitFlowSol: -0.05,
  exitOnDevSell: true,
  skipDevSold: true,
  maxExposureSol: 2,
  maxEntries: 1,
  targetCoins: 30,
  targetFills: 100,
  paceSecs: 21600,
  probeSol: 0.012,
  maxProbes: 1,
};

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Coin {
  creator: string;
  createSlot: number;
  createPrice: number;
  ticks: Tick[];
  entries: number;
  lastExit: number;
  creatorSold: boolean;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  invested: number;
  adds: number;
  lastBuyPrice: number;
  tp1Done: boolean;
  filled: boolean;
}

/** Net SOL the bot would receive for selling `tokens` at these reserves, fees and tx fee deducted. */
function liquidationLamports(tokens: bigint, vq: bigint, vt: bigint, txFee: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const raw = (tokens * vq) / (vt + tokens);
  const fee = (raw * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
  const net = raw - fee;
  return net > txFee ? net - txFee : 0n;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** client_ids of partial take-profit sells still awaiting their fill. */
  const tp1Pending = new Set<string>();
  let orderNo = 0;
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { creator: '', createSlot: -1, createPrice: 0, ticks: [], entries: 0, lastExit: -1e12, creatorSold: false, lastTradeSlot: -1 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots, and distinct recent buyers. */
  const recentFlow = (c: Coin, now: number, w: number): { net: number; buyers: Set<string> } => {
    let net = 0;
    const buyers = new Set<string>();
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const t = c.ticks[i]!;
      if (t.slot <= now - w) break;
      net += t.buy ? t.sol : -t.sol;
      if (t.buy && t.user !== c.creator) buyers.add(t.user);
    }
    return { net, buyers };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      // Settle partial take-profits: only a filled partial banks tp1; a
      // rejected or failed one stays retryable.
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
        if (tp1Pending.has(f.client_id)) {
          tp1Pending.delete(f.client_id);
          if (f.status === 'filled') {
            const h = held.get(f.mint);
            if (h !== undefined) h.tp1Done = true;
          }
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
      }
      const touched: Pubkey[] = [];
      const touchedSet = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.creator = e.creator;
          c.createSlot = e.slot;
          c.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / Number(SOL);
          c.ticks.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          c.lastTradeSlot = e.slot;
          if (c.creator !== '' && e.user === c.creator && !e.is_buy) c.creatorSold = true;
          if (!touchedSet.has(e.mint)) {
            touchedSet.add(e.mint);
            touched.push(e.mint);
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const txSol = Number(tx) / LAMPORTS;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const cur = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') cur.buy = true;
        else cur.sell = true;
        pendingByMint.set(po.order.mint, cur);
      }

      // 1. Exits first, in deterministic mint order.
      const heldMints = [...state.positions.keys()].sort();
      for (const mint of heldMints) {
        const h = held.get(mint);
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        const c = coinOf(mint);
        if (h === undefined) continue;
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.get(mint)?.sell) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = Number(liquidationLamports(pos.token_amount, vq, vt, tx)) / LAMPORTS;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const gain = cost > 0 ? value / cost - 1 : 0;
        const flow = recentFlow(c, now, p.flowWindowSlots);
        let sellShare = 0;
        if (!h.tp1Done && gain >= p.tp1) sellShare = p.tp1Share;
        else if (h.tp1Done && gain >= p.takeProfit) sellShare = 1;
        else if (gain <= (h.tp1Done ? -p.stopAfterTp1 : -p.stopLoss)) sellShare = 1;
        else if (now - h.opened > p.maxHoldSlots) sellShare = 1;
        else if (p.exitOnDevSell && c.creatorSold) sellShare = 1;
        else if (flow.net < p.exitFlowSol) sellShare = 1;
        else if (now - c.lastTradeSlot > p.staleSlots) sellShare = 1;
        if (sellShare <= 0) continue;
        if (orders.length >= cap) break;
        const tokens = sellShare >= 1 ? pos.token_amount : (pos.token_amount * BigInt(Math.floor(p.tp1Share * 1000))) / 1000n;
        if (tokens <= 0n) continue;
        const clientId = `s${++orderNo}`;
        if (sellShare < 1) tp1Pending.add(clientId);
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000, client_id: clientId });
      }

      // 1b. Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of [...probes]) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 2. Housekeeping: forget positions that are gone.
      for (const [mint, h] of [...held]) {
        if (!state.positions.has(mint) && !pendingByMint.has(mint)) {
          held.delete(mint);
          if (h.filled) coinOf(mint).lastExit = now;
        }
      }

      // 3. Entries and adds on coins that traded this batch.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += h.invested;
      for (const mint of touched) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        if (pendingByMint.has(mint)) continue;
        const c = coins.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (c.createSlot < 0) continue;
        const age = now - c.createSlot;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const h = held.get(mint);
        if (h !== undefined) {
          // One add into strength: price stepped up from the last buy, flow still positive.
          if (h.adds >= p.maxAdds || h.tp1Done || !h.filled) continue;
          if (price < h.lastBuyPrice * (1 + p.addStep)) continue;
          const flow = recentFlow(c, now, p.flowWindowSlots);
          if (flow.net < p.minFlowSol) continue;
          let amount = Math.min(p.stakeSol - h.invested, p.stakeSol - p.firstSol);
          if (amount <= 0) continue;
          const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          if (amount > capSol) amount = capSol;
          if (amount > free - txSol) amount = free - txSol;
          if (amount > p.maxExposureSol - exposure) amount = p.maxExposureSol - exposure;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + txSol;
          exposure += amount;
          h.invested += amount;
          h.adds++;
          h.lastBuyPrice = price;
          continue;
        }
        // First buy: the opening tape must look like a real launch.
        if (c.entries >= p.maxEntries) continue;
        if (age < p.minAgeSlots || age > p.maxAgeSlots) continue;
        if (p.skipDevSold && c.creatorSold) continue;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        let devBuy = 0;
        let bought = 0;
        let sold = 0;
        let biggestSell = 0;
        const buyers = new Set<string>();
        for (const t of c.ticks) {
          if (t.user === c.creator) {
            if (t.buy) devBuy += t.sol;
          } else if (t.buy) {
            bought += t.sol;
            buyers.add(t.user);
          } else {
            sold += t.sol;
            if (t.sol > biggestSell) biggestSell = t.sol;
          }
        }
        if (devBuy < p.minDevBuySol || devBuy > p.maxDevBuySol) continue;
        if (buyers.size < p.minBuyers || buyers.size > p.maxBuyers) continue;
        if (bought + devBuy < p.minBoughtSol) continue;
        if (bought > 0 && sold / bought > p.maxSellRatio) continue;
        if (biggestSell > p.maxBigSellShare * rqSol) continue;
        if (c.createPrice > 0) {
          const runup = price / c.createPrice - 1;
          if (runup < p.minRunup || runup > p.maxRunup) continue;
        }
        const flow = recentFlow(c, now, p.flowWindowSlots);
        if (flow.net < p.minFlowSol || flow.buyers.size < p.minRecentBuyers) continue;
        let amount = Math.min(p.firstSol, p.stakeSol);
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        if (amount > capSol) amount = capSol;
        if (amount > free - txSol) amount = free - txSol;
        if (amount > p.maxExposureSol - exposure) amount = p.maxExposureSol - exposure;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        slotsLeft--;
        held.set(mint, { opened: now, invested: amount, adds: 0, lastBuyPrice: price, tp1Done: false, filled: false });
        c.entries++;
      }

      // 4. Guardrail pacing: open a probe when fills or coins lag the pace.
      // The final window is 6h, so the main signal alone (~1 coin/hour) would
      // miss the 20-coin bar; probes are tiny round trips on liquid curves
      // that keep the run above it at a negligible fee cost.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
