/**
 * 將免費 MLB Stats API 的前季 platoon 左右對決寫入歷史 feature rows。
 * 多數舊列沒有 pitcher id，會從官方 boxscore 解析先發後再抓 splits。
 */
import db from '../src/db/database.js';
import {
  buildMlbPregamePlatoonBlock,
  getMlbGameBoxscore,
  getMlbScheduleAround,
  matchMlbOfficialGame,
  resolveMlbTeamId,
} from '../src/services/MlbStatsService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
      await sleep(35);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => run())
  );
  return results;
}

async function resolveOfficialAndStarters(row) {
  if (String(row.gameId).startsWith('mlb-official-')) {
    const gamePk = Number(String(row.gameId).slice('mlb-official-'.length));
    const boxscore = await getMlbGameBoxscore(gamePk);
    return {
      gamePk,
      homePitcherId: boxscore?.teams?.home?.pitchers?.[0] ?? null,
      awayPitcherId: boxscore?.teams?.away?.pitchers?.[0] ?? null,
      homeTeamId: boxscore?.teams?.home?.team?.id ?? null,
      awayTeamId: boxscore?.teams?.away?.team?.id ?? null,
    };
  }
  const schedule = await getMlbScheduleAround(row.commenceTime);
  const official = matchMlbOfficialGame({
    commence_time: row.commenceTime,
    home_team: row.homeTeam,
    away_team: row.awayTeam,
  }, schedule);
  if (!official?.gamePk) {
    return {
      gamePk: null,
      homePitcherId: null,
      awayPitcherId: null,
      homeTeamId: null,
      awayTeamId: null,
    };
  }
  const boxscore = await getMlbGameBoxscore(official.gamePk);
  return {
    gamePk: official.gamePk,
    homePitcherId: boxscore?.teams?.home?.pitchers?.[0] ?? null,
    awayPitcherId: boxscore?.teams?.away?.pitchers?.[0] ?? null,
    homeTeamId:
      official?.teams?.home?.team?.id ??
      boxscore?.teams?.home?.team?.id ??
      null,
    awayTeamId:
      official?.teams?.away?.team?.id ??
      boxscore?.teams?.away?.team?.id ??
      null,
  };
}

const force = process.argv.includes('--force');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;
const fromArg = process.argv.find((arg) => arg.startsWith('--from='));
const from = fromArg ? fromArg.split('=')[1] : '2025-05-01';

const rows = db.prepare(`
  SELECT f.game_id AS gameId,
         f.commence_time AS commenceTime,
         f.features_json AS featuresJson,
         g.home_team AS homeTeam,
         g.away_team AS awayTeam
  FROM mlb_historical_feature_rows f
  JOIN games g ON g.id = f.game_id
  WHERE f.feature_version = ?
    AND datetime(f.commence_time) >= datetime(?)
  ORDER BY datetime(f.commence_time), f.game_id
`).all(MLB_BASELINE_FEATURE_VERSION, `${from}T00:00:00Z`);

const selected = Number.isFinite(limit) && limit > 0
  ? rows.slice(0, limit)
  : rows;

console.error(`platoon sync candidates=${selected.length} from=${from} force=${force}`);

const update = db.prepare(`
  UPDATE mlb_historical_feature_rows
  SET features_json = ?, created_at = datetime('now')
  WHERE game_id = ?
`);

let updated = 0;
let skipped = 0;
let failed = 0;
let missingStarter = 0;

await mapPool(selected, 3, async (row) => {
  try {
    const features = JSON.parse(row.featuresJson);
    if (features?.platoon?.asOfSeason && !force) {
      skipped += 1;
      return;
    }
    const season = Number(String(row.commenceTime).slice(0, 4));
    let homePitcherId =
      features?.pitchers?.homeIdentity?.id ||
      features?.pitchers?.home?.id ||
      null;
    let awayPitcherId =
      features?.pitchers?.awayIdentity?.id ||
      features?.pitchers?.away?.id ||
      null;
    let homeTeamId = null;
    let awayTeamId = null;

    if (!homePitcherId || !awayPitcherId) {
      const resolved = await resolveOfficialAndStarters(row);
      homePitcherId = homePitcherId || resolved.homePitcherId;
      awayPitcherId = awayPitcherId || resolved.awayPitcherId;
      homeTeamId = resolved.homeTeamId;
      awayTeamId = resolved.awayTeamId;
    }

    if (!homeTeamId || !awayTeamId) {
      [homeTeamId, awayTeamId] = await Promise.all([
        resolveMlbTeamId(row.homeTeam, season),
        resolveMlbTeamId(row.awayTeam, season),
      ]);
    }

    if (!homePitcherId || !awayPitcherId) {
      missingStarter += 1;
    }

    const platoon = await buildMlbPregamePlatoonBlock({
      homePitcherId,
      awayPitcherId,
      homeTeamId,
      awayTeamId,
      commenceTime: row.commenceTime,
    });
    if (!platoon) {
      failed += 1;
      return;
    }

    features.platoon = platoon;
    features.pitchers = {
      ...(features.pitchers || {}),
      homeIdentity: {
        ...(features.pitchers?.homeIdentity || {}),
        id: homePitcherId,
      },
      awayIdentity: {
        ...(features.pitchers?.awayIdentity || {}),
        id: awayPitcherId,
      },
      homeHand: platoon.home.pitchHand,
      awayHand: platoon.away.pitchHand,
    };
    features.homeTeam = row.homeTeam;
    features.awayTeam = row.awayTeam;
    update.run(JSON.stringify(features), row.gameId);
    updated += 1;
    if (updated % 50 === 0) {
      console.error(
        `updated=${updated} skipped=${skipped} failed=${failed} missingStarter=${missingStarter}`
      );
    }
  } catch (error) {
    failed += 1;
    console.error(`fail ${row.gameId}: ${error?.message || error}`);
  }
});

console.log(JSON.stringify({
  ok: true,
  candidates: selected.length,
  updated,
  skipped,
  failed,
  missingStarter,
}, null, 2));
