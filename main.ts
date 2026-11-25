// Steady Launch Scalper — entrypoint. The strategy lives in strategy.ts; the
// grader runs `node main.ts` (Node 22). The SDK shim is vendored at
// vendor/makefun-bot.ts, byte for byte from the kit.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
