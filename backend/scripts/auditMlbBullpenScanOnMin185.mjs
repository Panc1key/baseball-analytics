/**
 * min185 底座：bullpen load／blowup 過濾掃描
 * 閘門：合併 usd50 > 基線，且 2025、2026 都正；嚴格：雙窗都不低於基線
 * 產物：tmp-bullpen-scan-on-min185.json
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

    const homeBp = Number(signals.homeBullpenPitches);
    const awayBp = Number(signals.awayBullpenPitches);
    const pickBp = pickHome ? homeBp : awayBp;
    const oppBp = pickHome ? awayBp : homeBp;
    const homeBlow = Number(signals.homePitchingBlowupRisk) || 0;
    const awayBlow = Number(signals.awayPitchingBlowupRisk) || 0;
    const pickBlow = pickHome ? homeBlow : awayBlow;
    const oppBlow = pickHome ? awayBlow : homeBlow;
    const homeBpEra = Number(features?.bullpen?.home?.era);
    const awayBpEra = Number(features?.bullpen?.away?.era);
    const pickBpEra = pickHome ? homeBpEra : awayBpEra;
    const oppBpEra = pickHome ? awayBpEra : homeBpEra;
    const homeBpWhip = Number(features?.bullpen?.home?.whip);
    const awayBpWhip = Number(features?.bullpen?.away?.whip);
    const pickBpWhip = pickHome ? homeBpWhip : awayBpWhip;
    const oppBpWhip = pickHome ? awayBpWhip : homeBpWhip;

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
      pickBp,
      oppBp,
      hasBothBp: Number.isFinite(pickBp) && Number.isFinite(oppBp),
      pickBpFresherOrEqual:
        Number.isFinite(pickBp) && Number.isFinite(oppBp) && pickBp <= oppBp,
      pickBpFresher:
        Number.isFinite(pickBp) && Number.isFinite(oppBp) && pickBp < oppBp,
      pickBpNotOverloaded220: !Number.isFinite(pickBp) || pickBp < 220,
      pickBpNotOverloaded210: !Number.isFinite(pickBp) || pickBp < 210,
      oppBpOverloaded220: Number.isFinite(oppBp) && oppBp >= 220,
      oppBpOverloaded210: Number.isFinite(oppBp) && oppBp >= 210,
      bothNotOverloaded210:
        (!Number.isFinite(homeBp) || homeBp < 210) &&
        (!Number.isFinite(awayBp) || awayBp < 210),
      pickBlowNotHigher: pickBlow <= oppBlow,
      pickBlowLower: pickBlow < oppBlow,
      pickBpEraBetter:
        Number.isFinite(pickBpEra) &&
        Number.isFinite(oppBpEra) &&
        pickBpEra <= oppBpEra,
      pickBpWhipBetter:
        Number.isFinite(pickBpWhip) &&
        Number.isFinite(oppBpWhip) &&
        pickBpWhip <= oppBpWhip,
      pickBpFreshAndOppTired:
        Number.isFinite(pickBp) &&
        Number.isFinite(oppBp) &&
        pickBp <= 170 &&
        oppBp >= 210,
      // 輕排：不過濾，僅改變同分決勝（另測）
      bpTieBoost: Number.isFinite(pickBp) && Number.isFinite(oppBp) ? oppBp - pickBp : 0,
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
  { id: 'pick_bp_fresher_or_equal', label: '選邊牛棚球數≤對手', fn: (g) => g.pickBpFresherOrEqual },
  { id: 'pick_bp_fresher', label: '選邊牛棚更鮮', fn: (g) => g.pickBpFresher },
  {
    id: 'pick_bp_not_ol220',
    label: '選邊牛棚未超載220（缺資料放行）',
    fn: (g) => g.pickBpNotOverloaded220,
  },
  {
    id: 'pick_bp_not_ol210',
    label: '選邊牛棚未超載210（缺資料放行）',
    fn: (g) => g.pickBpNotOverloaded210,
  },
  { id: 'opp_bp_ol220', label: '對手牛棚超載≥220', fn: (g) => g.oppBpOverloaded220 },
  { id: 'opp_bp_ol210', label: '對手牛棚超載≥210', fn: (g) => g.oppBpOverloaded210 },
  { id: 'both_not_ol210', label: '雙方牛棚皆未超載210', fn: (g) => g.bothNotOverloaded210 },
  {
    id: 'pick_fresh_opp_tired',
    label: '我方≤170 且對手≥210',
    fn: (g) => g.pickBpFreshAndOppTired,
  },
  { id: 'pick_blow_not_higher', label: '選邊 blowupRisk≤對手', fn: (g) => g.pickBlowNotHigher },
  { id: 'pick_blow_lower', label: '選邊 blowupRisk<對手', fn: (g) => g.pickBlowLower },
  { id: 'pick_bp_era_better', label: '選邊牛棚 ERA≤對手', fn: (g) => g.pickBpEraBetter },
  { id: 'pick_bp_whip_better', label: '選邊牛棚 WHIP≤對手', fn: (g) => g.pickBpWhipBetter },
  {
    id: 'combo_fresher_eq_not_ol220',
    label: '更鮮或相等 + 未超載220',
    fn: (g) => g.pickBpFresherOrEqual && g.pickBpNotOverloaded220,
  },
  {
    id: 'tiebreak_fresher_bp',
    label: '不過濾；同分時偏好對手牛棚更累',
    fn: () => true,
    compareExtra: (a, b) => b.bpTieBoost - a.bpTieBoost,
  },
];

const pools = WINDOWS.map((w) => ({ ...w, pool: buildPool(w.from, w.to) }));
const combinedPool = pools.flatMap((p) => p.pool);

const coverage = {
  poolSize: combinedPool.length,
  withBothBp: combinedPool.filter((g) => g.hasBothBp).length,
  pickBpGe220: combinedPool.filter((g) => Number.isFinite(g.pickBp) && g.pickBp >= 220).length,
  oppBpGe220: combinedPool.filter((g) => Number.isFinite(g.oppBp) && g.oppBp >= 220).length,
  avgPickBp: Number(
    (
      combinedPool.filter((g) => Number.isFinite(g.pickBp)).reduce((s, g) => s + g.pickBp, 0) /
      Math.max(1, combinedPool.filter((g) => Number.isFinite(g.pickBp)).length)
    ).toFixed(1)
  ),
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
    keepRate: c && bc ? Number((c.bets / bc.bets).toFixed(3)) : null,
    dualPositive,
    beatsBaseCombined,
    notWorseBothWindows: notWorseBoth,
    passGate: beatsBaseCombined && dualPositive,
    passStrictGate: beatsBaseCombined && dualPositive && notWorseBoth,
  };
});
evaluated.sort((a, b) => (b.deltaUsd50VsBase ?? -1e9) - (a.deltaUsd50VsBase ?? -1e9));

const pass = evaluated.filter((e) => e.passGate && e.id !== 'baseline_min185');
const passStrict = evaluated.filter((e) => e.passStrictGate && e.id !== 'baseline_min185');

const out = {
  experimentId: 'bullpen-on-min185-2026-07-27',
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
          action: 'do_not_add_bullpen_filter',
          note: '無過濾同時滿足：合併總美元>基線 且 雙窗都正',
        },
};

fs.writeFileSync(
  new URL('../tmp-bullpen-scan-on-min185.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      coverage,
      baseline: {
        bets: out.baseline.combined.bets,
        hit: out.baseline.combined.hitRate,
        roi: out.baseline.combined.roi,
        usd50: out.baseline.combined.usd50,
      },
      recommendation: out.recommendation,
      topByDelta: evaluated.slice(0, 10).map((e) => ({
        id: e.id,
        deltaUsd50: e.deltaUsd50VsBase,
        keepRate: e.keepRate,
        usd50: e.combined?.usd50,
        hit: e.combined?.hitRate,
        roi: e.combined?.roi,
        dualPositive: e.dualPositive,
        passGate: e.passGate,
        passStrict: e.passStrictGate,
        y25: e.y2025?.usd50,
        y26: e.y2026?.usd50,
      })),
    },
    null,
    2
  )
);
