import { rebuildMlbBaseline } from '../src/services/MlbHistoricalBaseline.js';

const daysArg = process.argv[2];
const days = daysArg == null || daysArg === 'all' ? null : Number(daysArg);
if (days != null && (!Number.isInteger(days) || days < 14)) {
  throw new Error('usage: node scripts/buildMlbBaseline.mjs [all|days>=14]');
}

const to = new Date();
const from = days == null ? null : new Date(to);
if (from) from.setUTCDate(from.getUTCDate() - days);
const result = await rebuildMlbBaseline({
  from: from?.toISOString(),
  to: to.toISOString(),
});

console.log(JSON.stringify({
  rows: result.rows,
  from: result.from,
  to: result.to,
  metrics: result.metrics,
}, null, 2));
