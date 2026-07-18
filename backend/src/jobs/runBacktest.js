import 'dotenv/config';
import {
  runHistoricalBacktest,
  formatBacktestReport,
} from '../services/HistoricalBacktest.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const primaryOnly = process.argv.includes('--primary');
const flatOnly = process.argv.includes('--flat');
const includeSample = process.argv.includes('--include-sample');
const allPicks = process.argv.includes('--all-picks');
const allTime = process.argv.includes('--all-time');
const pointInTimeForm = process.argv.includes('--pit');
const leagueArg = argValue('league');
const daysRaw = argValue('days');
const days = allTime ? null : daysRaw != null ? Number(daysRaw) : 30;
const leagues = leagueArg
  ? leagueArg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  : undefined;

const report = await runHistoricalBacktest({
  days,
  leagues,
  primaryOnly,
  flatBetOnly: flatOnly,
  excludeSample: !includeSample,
  topPickPerGame: !allPicks,
  pointInTimeForm,
});

console.log(formatBacktestReport(report));
console.log('\n=== 全部明細 ===');
for (const d of report.details) {
  console.log(
    `[${d.result}] ${String(d.commenceTime || '').slice(0, 10)} ${d.league} ${d.tier} ${d.market} ${d.pick}` +
      ` @${d.odds?.toFixed?.(2) ?? d.odds} p=${(d.modelProb * 100).toFixed(1)}%` +
      ` ev=${(d.ev * 100).toFixed(1)}% score=${d.score} | ${d.teams}`
  );
}

console.log('\n' + report.note);
console.log(
  '用法: node src/jobs/runBacktest.js [--days=30] [--league=MLB] [--primary] [--flat] [--pit] [--all-time] [--all-picks] [--include-sample]'
);
console.log('  --pit: 開賽前 point-in-time 近窗（免費 MLB Stats API，不耗 Odds 額度）');
