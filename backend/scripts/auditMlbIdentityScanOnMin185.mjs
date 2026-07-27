/**
 * min185 底座：starter identity／投打左右掃描
 * 閘門：合併 usd50 > 基線，且 2025、2026 都正；嚴格：雙窗都不低於基線
 * 產物：tmp-identity-scan-on-min185.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RECOMMENDATION_RULES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const RULES = MLB_MONEYLINE_RECOMMENDATION_RULES;
const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hkDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function bestMl(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    if (!market?.outcomes?.length) continue;
    const home =
      market.outcomes.find((o) => o.name === homeTeam) ||
      market.outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      market.outcomes.find((o) => o.name === awayTeam) ||
      market.outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const vig = 1 / home.price + 1 / away.price;
    if (!best || vig < best.vig) best = { homeOdds: Number(home.price), awayOdds: Number(away.price) };
  }
  return best;
}

function summarize(bets) {
  if (!bets.length) return null;
  let unit = 0;
  let odds = 0;
  let hits = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    unitPnl: Number(unit.toFixed(2)),
    usd50: Math.round(unit * 50),
    usd75: Math.round(unit * 75),
  };
}

function buildPool(fromDate, toDate) {
  const validation = getLatestMlbExpectedRunsValidation();
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, fromDate, toDate);

  const pool = [];
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (hs === as) continue;
    const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
    const ph = Number(pred.homeExpectedRuns);
    const pa = Number(pred.awayExpectedRuns);
    if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
    const pickHome = ph >= pa;
    const modelProb = pickHome
      ? Number(pred.markets?.homeWinProbability)
      : Number(pred.markets?.awayWinProbability);
    if (!Number.isFinite(modelProb)) continue;
    const ml = bestMl(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (!ml) continue;
    const pickOdds = pickHome ? ml.homeOdds : ml.awayOdds;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    const signals = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(signals.homeEarlyExitsLast3) || 0
      : Number(signals.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(signals.awayEarlyExitsLast3) || 0
      : Number(signals.homeEarlyExitsLast3) || 0;

    if (
      ev < RULES.minimumExpectedValue ||
      margin < RULES.minimumExpectedRunMargin ||
      modelProb < RULES.minimumModelProbability ||
      (RULES.minimumPickOdds != null && pickOdds < RULES.minimumPickOdds) ||
      (RULES.maximumPickOdds != null && pickOdds > RULES.maximumPickOdds) ||
      (RULES.requirePickEarlyExitsNotHigher && pickEarly > oppEarly)
    ) {
      continue;
    }

    const pitchers = features?.pitchers || {};
    const identityMode = pitchers.identityMode || 'missing';
    const homeId = pitchers.homeIdentity?.id ?? pitchers.home?.id ?? null;
    const awayId = pitchers.awayIdentity?.id ?? pitchers.away?.id ?? null;
    const homeHand = pitchers.homeHand || null;
    const awayHand = pitchers.awayHand || null;
    const pickHand = pickHome ? homeHand : awayHand;
    const oppHand = pickHome ? awayHand : homeHand;
    const bothIds = homeId != null && awayId != null;
    const bothHands = Boolean(homeHand && awayHand);
    const sameHand = bothHands && homeHand === awayHand;
    const oppositeHand = bothHands && homeHand !== awayHand;
    const hasSnapshot = Boolean(pitchers.identitySnapshotId);
    const isPit = identityMode === 'pit_probable';
    const isOracle =
      identityMode === 'postgame_actual_oracle' ||
      identityMode === 'oracle' ||
      String(identityMode).includes('oracle');
    const isLiveFallback = identityMode === 'live_fallback';

    pool.push({
      day: hkDate(row.commenceTime),
      window: fromDate.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickOdds,
      ev,
      margin,
      modelProb,
      score: scoreMlbMoneylineDailyRank(
        { expectedValue: ev, modelProbability: modelProb },
        RULES
      ),
      identityMode,
      isPit,
      isOracle,
      isLiveFallback,
      bothIds,
      bothHands,
      hasSnapshot,
      sameHand,
      oppositeHand,
      pickHand,
      oppHand,
      pickIsL: pickHand === 'L',
      pickIsR: pickHand === 'R',
      // 輕排：PIT 身份略加權（不過濾）
      identityTieBoost: isPit ? 1 : isOracle ? 0 : -1,
    });
  }
  return pool;
}

function select(pool, filterFn, compareExtra = null) {
  const byDay = new Map();
  for (const g of pool) {
    if (!filterFn(g)) continue;
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (compareExtra) {
            const t = compareExtra(a, b);
            if (t !== 0) return t;
          }
          return b.margin - a.margin;
        })
        .slice(0, RULES.dailyTopK)
    );
  }
  return out;
}

const FILTERS = [
  { id: 'baseline_min185', label: 'min185 基線', fn: () => true },
  { id: 'require_both_ids', label: '雙方先發 ID 皆有', fn: (g) => g.bothIds },
  { id: 'require_both_hands', label: '雙方投擲左右皆知', fn: (g) => g.bothHands },
  { id: 'require_ids_and_hands', label: 'ID+左右皆完整', fn: (g) => g.bothIds && g.bothHands },
  { id: 'only_pit_probable', label: '僅 pit_probable（嚴格賽前身份）', fn: (g) => g.isPit },
  { id: 'exclude_oracle', label: '排除 postgame oracle', fn: (g) => !g.isOracle },
  { id: 'only_oracle', label: '僅 oracle（對照，非正式候選）', fn: (g) => g.isOracle },
  { id: 'require_snapshot', label: '需 identitySnapshotId', fn: (g) => g.hasSnapshot },
  { id: 'same_hand_starters', label: '雙先發同側（L-L / R-R）', fn: (g) => g.sameHand },
  { id: 'opposite_hand_starters', label: '雙先發異側', fn: (g) => g.oppositeHand },
  { id: 'pick_L', label: '選邊先發為左投', fn: (g) => g.pickIsL },
  { id: 'pick_R', label: '選邊先發為右投', fn: (g) => g.pickIsR },
  {
    id: 'exclude_missing_mode',
    label: '排除 identityMode missing',
    fn: (g) => g.identityMode !== 'missing',
  },
  {
    id: 'tiebreak_prefer_pit',
    label: '不過濾；同分偏好 pit_probable',
    fn: () => true,
    compareExtra: (a, b) => b.identityTieBoost - a.identityTieBoost,
  },
];

const pools = WINDOWS.map((w) => ({ ...w, pool: buildPool(w.from, w.to) }));
const combinedPool = pools.flatMap((p) => p.pool);

const modeCounts = {};
for (const g of combinedPool) {
  modeCounts[g.identityMode] = (modeCounts[g.identityMode] || 0) + 1;
}

const coverage = {
  poolSize: combinedPool.length,
  modeCounts,
  bothIds: combinedPool.filter((g) => g.bothIds).length,
  bothHands: combinedPool.filter((g) => g.bothHands).length,
  pitProbable: combinedPool.filter((g) => g.isPit).length,
  oracle: combinedPool.filter((g) => g.isOracle).length,
  hasSnapshot: combinedPool.filter((g) => g.hasSnapshot).length,
  sameHand: combinedPool.filter((g) => g.sameHand).length,
  oppositeHand: combinedPool.filter((g) => g.oppositeHand).length,
};

const results = [];
for (const f of FILTERS) {
  const row = { id: f.id, label: f.label, windows: {} };
  for (const w of pools) {
    row.windows[w.key] = summarize(select(w.pool, f.fn, f.compareExtra || null));
  }
  row.windows.combined = summarize(select(combinedPool, f.fn, f.compareExtra || null));
  results.push(row);
}

const base = results.find((r) => r.id === 'baseline_min185');
const evaluated = results.map((r) => {
  const c = r.windows.combined;
  const y25 = r.windows['2025'];
  const y26 = r.windows['2026'];
  const bc = base.windows.combined;
  const deltaUsd50 = c && bc ? c.usd50 - bc.usd50 : null;
  const dualPositive = (y25?.usd50 ?? -1) > 0 && (y26?.usd50 ?? -1) > 0;
  const beatsBaseCombined = (c?.usd50 ?? -Infinity) > (bc?.usd50 ?? 0);
  const notWorseBoth =
    (y25?.usd50 ?? -Infinity) >= (base.windows['2025']?.usd50 ?? 0) &&
    (y26?.usd50 ?? -Infinity) >= (base.windows['2026']?.usd50 ?? 0);
  return {
    id: r.id,
    label: r.label,
    combined: c,
    y2025: y25,
    y2026: y26,
    deltaUsd50VsBase: deltaUsd50,
    deltaUsd75VsBase: c && bc ? c.usd75 - bc.usd75 : null,
    keepRate: c && bc && bc.bets ? Number((c.bets / bc.bets).toFixed(3)) : null,
    dualPositive,
    beatsBaseCombined,
    notWorseBothWindows: notWorseBoth,
    passGate: Boolean(c) && beatsBaseCombined && dualPositive,
    passStrictGate: Boolean(c) && beatsBaseCombined && dualPositive && notWorseBoth,
  };
});
evaluated.sort((a, b) => (b.deltaUsd50VsBase ?? -1e9) - (a.deltaUsd50VsBase ?? -1e9));

const pass = evaluated.filter((e) => e.passGate && e.id !== 'baseline_min185');
const passStrict = evaluated.filter((e) => e.passStrictGate && e.id !== 'baseline_min185');

const out = {
  experimentId: 'identity-on-min185-2026-07-27',
  generatedAt: new Date().toISOString(),
  baseRules: {
    id: RULES.id,
    minimumPickOdds: RULES.minimumPickOdds,
    dailyTopK: RULES.dailyTopK,
  },
  coverage,
  baseline: evaluated.find((e) => e.id === 'baseline_min185'),
  passGate: pass,
  passStrictGate: passStrict,
  rankedByDeltaUsd50: evaluated,
  recommendation: passStrict[0]
    ? {
        action: 'consider_formal',
        id: passStrict[0].id,
        label: passStrict[0].label,
        deltaUsd50: passStrict[0].deltaUsd50VsBase,
      }
    : pass[0]
      ? {
          action: 'weak_candidate_recheck',
          id: pass[0].id,
          label: pass[0].label,
          note: '合併贏基線且雙窗正，但至少一窗低於基線',
          deltaUsd50: pass[0].deltaUsd50VsBase,
        }
      : {
          action: 'do_not_add_identity_filter',
          note: '無過濾同時滿足：合併總美元>基線 且 雙窗都正（或樣本不足以當規則）',
        },
};

fs.writeFileSync(
  new URL('../tmp-identity-scan-on-min185.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      coverage,
      baseline: out.baseline?.combined && {
        bets: out.baseline.combined.bets,
        hit: out.baseline.combined.hitRate,
        roi: out.baseline.combined.roi,
        usd50: out.baseline.combined.usd50,
      },
      recommendation: out.recommendation,
      topByDelta: evaluated.slice(0, 12).map((e) => ({
        id: e.id,
        deltaUsd50: e.deltaUsd50VsBase,
        keepRate: e.keepRate,
        usd50: e.combined?.usd50 ?? null,
        bets: e.combined?.bets ?? 0,
        hit: e.combined?.hitRate ?? null,
        roi: e.combined?.roi ?? null,
        dualPositive: e.dualPositive,
        passGate: e.passGate,
        passStrict: e.passStrictGate,
        y25: e.y2025?.usd50 ?? null,
        y26: e.y2026?.usd50 ?? null,
      })),
    },
    null,
    2
  )
);
