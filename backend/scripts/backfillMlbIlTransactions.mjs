/**
 * 回填 MLB IL 放置／啟用交易事件（可回放）
 * 用法:
 *   node scripts/backfillMlbIlTransactions.mjs --from=2024-03 --to=2026-07
 *   node scripts/backfillMlbIlTransactions.mjs --from=2025-06 --to=2025-06
 */
import fs from 'fs';
import {
  syncMlbIlTransactionsByMonth,
  getMlbIlEventCoverage,
} from '../src/services/MlbIlTransactionService.js';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const fromYm = argValue('from', '2024-03');
const toYm = argValue('to', '2026-07');
const pauseMs = Number(argValue('pauseMs', '100'));

console.log(JSON.stringify({ fromYm, toYm, pauseMs }, null, 2));
const logs = await syncMlbIlTransactionsByMonth(fromYm, toYm, { pauseMs });
const coverage = getMlbIlEventCoverage();
const out = {
  fromYm,
  toYm,
  months: logs.length,
  insertedSum: logs.reduce((s, x) => s + x.inserted, 0),
  ilEventsSum: logs.reduce((s, x) => s + x.ilEvents, 0),
  coverage,
};
fs.writeFileSync(
  new URL('../tmp-backfill-mlb-il-transactions.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
