import { backfillMlbOfficialHistory } from '../src/services/MlbOfficialHistoryBackfill.js';

const seasons = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [2024, 2025];
if (seasons.some((season) => !Number.isInteger(season) || season < 2000 || season > 2100)) {
  throw new Error('usage: node scripts/backfillMlbOfficialHistory.mjs [season ...]');
}

const reports = [];
for (const season of seasons) {
  reports.push(await backfillMlbOfficialHistory({
    startDate: `${season}-03-15`,
    endDate: `${season}-10-15`,
  }));
}

console.log(JSON.stringify({ seasons, reports }, null, 2));
