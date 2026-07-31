/**
 * 把真 IL 回歸旗標寫入 historical feature rows（features.pitchers.homeIlReturn / awayIlReturn）
 * 需先跑 backfillMlbIlTransactions.mjs
 *
 * 用法: node scripts/annotateMlbIlReturnOnFeatures.mjs [--from=2025-04-01] [--to=2026-07-28] [--limit=0]
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  buildIlReturnFlag,
  getMlbIlEventCoverage,
} from '../src/services/MlbIlTransactionService.js';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const fromDate = argValue('from', '2025-04-01');
const toDate = argValue('to', '2026-07-28');
const limit = Number(argValue('limit', '0'));

const coverage = getMlbIlEventCoverage();
if (!coverage.activated) {
  console.error('尚無 IL activated 事件，請先: node scripts/backfillMlbIlTransactions.mjs');
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
            f.home_win AS homeWin
     FROM mlb_historical_feature_rows f
     WHERE f.feature_version = ?
       AND date(f.commence_time) >= date(?)
       AND date(f.commence_time) <= date(?)
     ORDER BY f.commence_time`
  )
  .all(MLB_BASELINE_FEATURE_VERSION, fromDate, toDate);

const targets = limit > 0 ? rows.slice(0, limit) : rows;
const update = db.prepare(
  `UPDATE mlb_historical_feature_rows
   SET features_json = ?
   WHERE feature_version = ? AND game_id = ?`
);

let updated = 0;
let homeReturns = 0;
let awayReturns = 0;
let parseFail = 0;

const tx = db.transaction(() => {
  for (const row of targets) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      parseFail += 1;
      continue;
    }
    const commenceDate = String(row.commenceTime).slice(0, 10);
    const p = features.pitchers || (features.pitchers = {});
    const homeId = p.homeIdentity?.id ?? p.home?.id ?? null;
    const awayId = p.awayIdentity?.id ?? p.away?.id ?? null;
    const homeIp = p.home?.inningsPitched;
    const awayIp = p.away?.inningsPitched;

    const homeFlag = homeId
      ? buildIlReturnFlag({
          pitcherId: homeId,
          commenceDate,
          seasonIpBefore: homeIp,
        })
      : { isReturnPitcher: false, reason: 'no_id' };
    const awayFlag = awayId
      ? buildIlReturnFlag({
          pitcherId: awayId,
          commenceDate,
          seasonIpBefore: awayIp,
        })
      : { isReturnPitcher: false, reason: 'no_id' };

    p.homeIlReturn = homeFlag;
    p.awayIlReturn = awayFlag;
    if (homeFlag.isReturnPitcher) homeReturns += 1;
    if (awayFlag.isReturnPitcher) awayReturns += 1;

    update.run(JSON.stringify(features), MLB_BASELINE_FEATURE_VERSION, row.gameId);
    updated += 1;
  }
});
tx();

const out = {
  window: { fromDate, toDate },
  ilCoverage: coverage,
  rows: targets.length,
  updated,
  parseFail,
  homeReturns,
  awayReturns,
  eitherReturn: null,
  flagContract: {
    isReturnPitcher: 'daysSinceLastIlExit<=45 AND seasonIpBefore<30 (career_ip 暫不強制)',
    source: 'mlb_il_transaction_events.activated',
  },
};
out.eitherReturn = homeReturns + awayReturns;

fs.writeFileSync(
  new URL('../tmp-annotate-mlb-il-return.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
