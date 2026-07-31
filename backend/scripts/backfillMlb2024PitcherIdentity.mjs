/**
 * 為 2024 特徵列補先發身份（MLB Stats API boxscore → postgame_actual_oracle）
 * 不花 Odds API 額度。統計仍用開賽前 game log cutoff。
 *
 * 用法: node scripts/backfillMlb2024PitcherIdentity.mjs [--limit=50]
 */
import fs from 'fs';
import db from '../src/db/database.js';
import {
  MLB_BASELINE_FEATURE_VERSION,
  enrichRowsWithHistoricalPitchers,
  persistMlbHistoricalFeatureRows,
} from '../src/services/MlbHistoricalBaseline.js';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const fromDate = argValue('from', '2024-03-20');
const toDate = argValue('to', '2024-09-30');
const limit = Number(argValue('limit', '0'));
const concurrency = Number(argValue('concurrency', '4'));

const rowsRaw = db
  .prepare(
    `SELECT f.game_id AS gameId, f.commence_time AS commenceTime,
            f.features_json AS featuresJson, f.home_win AS homeWin,
            g.home_team AS homeTeam, g.away_team AS awayTeam,
            g.home_score AS homeScore, g.away_score AS awayScore
     FROM mlb_historical_feature_rows f
     JOIN games g ON g.id = f.game_id
     WHERE f.feature_version = ?
       AND date(f.commence_time) >= date(?)
       AND date(f.commence_time) <= date(?)
     ORDER BY f.commence_time`
  )
  .all(MLB_BASELINE_FEATURE_VERSION, fromDate, toDate);

const need = [];
for (const row of rowsRaw) {
  let features;
  try {
    features = JSON.parse(row.featuresJson);
  } catch {
    continue;
  }
  const p = features.pitchers || {};
  const hid = p.homeIdentity?.id ?? p.home?.id;
  const aid = p.awayIdentity?.id ?? p.away?.id;
  if (hid != null && aid != null && p.identityMode) continue;
  need.push({
    gameId: row.gameId,
    commenceTime: row.commenceTime,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    homeScore: row.homeScore,
    awayScore: row.awayScore,
    homeWin: row.homeWin,
    features,
  });
}

const targets = limit > 0 ? need.slice(0, limit) : need;
console.log(
  JSON.stringify(
    {
      window: { fromDate, toDate },
      totalRows: rowsRaw.length,
      needIdentity: need.length,
      willProcess: targets.length,
      concurrency,
    },
    null,
    2
  )
);

if (!targets.length) {
  console.log('無需補齊');
  process.exit(0);
}

const enriched = await enrichRowsWithHistoricalPitchers(targets, { concurrency });
const withIds = enriched.filter((r) => {
  const p = r.features?.pitchers || {};
  return (p.homeIdentity?.id ?? p.home?.id) != null && (p.awayIdentity?.id ?? p.away?.id) != null;
});

persistMlbHistoricalFeatureRows(enriched);

const out = {
  processed: enriched.length,
  withBothIds: withIds.length,
  pitcherFeaturesComplete: enriched.filter((r) => r.pitcherFeaturesComplete).length,
  sampleModes: [...new Set(enriched.map((r) => r.features?.pitchers?.identityMode).filter(Boolean))],
};

fs.writeFileSync(
  new URL('../tmp-backfill-2024-pitcher-identity.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
