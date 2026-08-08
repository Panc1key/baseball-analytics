/**
 * 历史回放：比赛形态（投手战禁大分 / 强主提示）对 Hybrid 的影响
 *
 *   node scripts/auditMlbGameShapeReplay.mjs
 * 产物: tmp-game-shape-replay.json
 *
 * 对比：
 * - baseline：现有正式 overlay 后的 Hybrid actionable
 * - ruleBanOver：规则认投手战 → 砍 Over
 * - dualBanOver：规则+LLM缓存都认 → 砍 Over（仅有缓存的子集也单独报）
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { decimalToImpliedProb, removeVig } from '../src/utils/odds.js';
import {
  classifyMlbTotalsHybridCandidate,
  MLB_TOTALS_SATELLITE_HYBRID_SPEC,
  MLB_TOTALS_SATELLITE_SPEC,
} from '../src/services/MlbTotalsSatellite.js';
import { config } from '../src/config.js';
import {
  detectPitcherDuel,
  detectStrongHome,
  MLB_GAME_SHAPE_SHADOW_SPEC,
} from '../src/services/MlbGameShapeShadow.js';
import { getCachedGameShapeLabel } from '../src/services/MlbGameShapeLlmService.js';
import { applyTotalsFragileUnderShadow } from '../src/services/MlbTotalsFragileUnderShadow.js';
import { applyTotalsUnderBlowupGapToCandidate } from '../src/services/MlbTotalsUnderBlowupGapShadow.js';
import { applyTotalsUnderPitcherToCandidate } from '../src/services/MlbTotalsUnderPitcherShadow.js';

const STAKE = 50;
const BASE = MLB_TOTALS_SATELLITE_SPEC.rules;
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-08-07' },
];

function finite(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function collectBestLine(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return { totals: null, homeOdds: null };
  let best = null;
  let homeOdds = null;
  const homeTeam = pit.home_team;
  for (const book of pit.bookmakers) {
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    if (h2h && homeTeam) {
      const home = h2h.outcomes?.find((o) => o.name === homeTeam);
      if (home?.price && (homeOdds == null || Number(home.price) < homeOdds)) {
        homeOdds = Number(home.price);
      }
    }
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market) continue;
    for (const over of market.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const overOdds = Number(over.price);
      const underOdds = Number(under.price);
      if (overOdds < BASE.pickOddsMin || underOdds < BASE.pickOddsMin) continue;
      if (overOdds > BASE.pickOddsMax || underOdds > BASE.pickOddsMax) continue;
      const vig = 1 / overOdds + 1 / underOdds;
      const fair = removeVig(
        decimalToImpliedProb(overOdds),
        decimalToImpliedProb(underOdds)
      );
      const cand = {
        line: Number(over.point),
        overOdds,
        underOdds,
        fairOver: fair.fairA,
        fairUnder: fair.fairB,
        vig,
      };
      if (!best || vig < best.vig) best = cand;
    }
  }
  return { totals: best, homeOdds };
}

function settle(side, line, total) {
  if (side === 'over') {
    if (total > line) return 'win';
    if (total < line) return 'loss';
    return 'push';
  }
  if (total < line) return 'win';
  if (total > line) return 'loss';
  return 'push';
}

function summarize(bets) {
  const decided = bets.filter((b) => b.result === 'win' || b.result === 'loss');
  if (!decided.length) {
    return { n: 0, hits: 0, hr: null, roi: null, usd: 0, avgOdds: null };
  }
  let hits = 0;
  let unit = 0;
  let odds = 0;
  for (const b of decided) {
    odds += b.odds;
    if (b.result === 'win') {
      hits += 1;
      unit += b.odds - 1;
    } else unit -= 1;
  }
  const n = decided.length;
  return {
    n,
    hits,
    hr: Number((hits / n).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd: Math.round(unit * STAKE * 100) / 100,
    avgOdds: Number((odds / n).toFixed(3)),
  };
}

function applyFormalOverlays(cls, features) {
  return applyTotalsUnderPitcherToCandidate(
    applyTotalsUnderBlowupGapToCandidate(
      applyTotalsFragileUnderShadow(cls, features),
      features
    )
  );
}

function deltaSummary(kept, baseline) {
  const b = summarize(baseline);
  const k = summarize(kept);
  return {
    kept: k,
    cut: summarize(baseline.filter((x) => !kept.includes(x))),
    dHrPp: k.hr != null && b.hr != null ? Number(((k.hr - b.hr) * 100).toFixed(2)) : null,
    dRoiPp:
      k.roi != null && b.roi != null ? Number(((k.roi - b.roi) * 100).toFixed(2)) : null,
    dUsd: Number((k.usd - b.usd).toFixed(2)),
    byYearDeltaUsd: Object.fromEntries(
      ['2024', '2025', '2026'].map((y) => {
        const bY = summarize(baseline.filter((x) => x.year === y));
        const kY = summarize(kept.filter((x) => x.year === y));
        return [y, Number((kY.usd - bY.usd).toFixed(2))];
      })
    ),
  };
}

console.log('[game-shape-replay] load…');
const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) {
  console.error('missing expected runs model');
  process.exit(1);
}

const pool = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id, f.commence_time, f.features_json,
              g.home_team, g.away_team, g.home_score, g.away_score
       FROM mlb_historical_feature_rows f
       JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ?
         AND f.commence_time >= ? AND f.commence_time <= ?
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, `${w.to}T23:59:59`);
  console.log(`  ${w.key} feature rows`, rows.length);
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.features_json);
    } catch {
      continue;
    }
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.home_team,
    });
    features.weather = getCachedMlbGameWeather(row.game_id)?.weather || null;
    const marketPack = collectBestLine(row.game_id, row.commence_time);
    const linePack = marketPack.totals;
    if (!linePack) continue;
    const pred = predictMlbGameRuns(model, features, {
      totalLine: linePack.line,
    });
    let cls = classifyMlbTotalsHybridCandidate({
      prediction: pred,
      totalsMarket: linePack,
      parkFactor: features.parkFactor,
      spec: {
        ...MLB_TOTALS_SATELLITE_HYBRID_SPEC,
        rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
      },
    });
    cls = applyFormalOverlays(cls, features);
    if (cls.tier !== 'actionable' || !cls.side) continue;
    const total = Number(row.home_score) + Number(row.away_score);
    const result = settle(cls.side, cls.line, total);
    const odds = cls.side === 'over' ? linePack.overOdds : linePack.underOdds;
    const duel = detectPitcherDuel(features, { totalsLine: cls.line });
    const strongHome = detectStrongHome(features, {
      homeOdds: marketPack.homeOdds,
    });
    const llm = getCachedGameShapeLabel(row.game_id);
    pool.push({
      year: w.key,
      gameId: row.game_id,
      matchup: `${row.away_team} @ ${row.home_team}`,
      side: cls.side,
      line: cls.line,
      odds,
      mu: pred.totalExpectedRuns ?? pred.mu ?? null,
      total,
      result,
      duel: duel.matched,
      strongHome: strongHome.matched,
      llmDuel: Boolean(llm?.pitcher_duel),
      hasLlm: Boolean(llm),
      eras: [duel.awayEra, duel.homeEra],
    });
  }
}

const baseline = pool;
const ruleKept = pool.filter((b) => !(b.side === 'over' && b.duel));
const dualKept = pool.filter((b) => !(b.side === 'over' && b.duel && b.llmDuel));
const withLlm = pool.filter((b) => b.hasLlm);
const dualOnLlmSubsetKept = withLlm.filter(
  (b) => !(b.side === 'over' && b.duel && b.llmDuel)
);

const cutRule = pool.filter((b) => b.side === 'over' && b.duel);
const cutDual = pool.filter((b) => b.side === 'over' && b.duel && b.llmDuel);

const out = {
  experimentId: 'game-shape-replay-2026-08-08',
  specId: MLB_GAME_SHAPE_SHADOW_SPEC.id,
  pitcherDuelSpec: MLB_GAME_SHAPE_SHADOW_SPEC.pitcherDuel,
  stakeUsd: STAKE,
  baseline: {
    all: summarize(baseline),
    overs: summarize(baseline.filter((b) => b.side === 'over')),
    unders: summarize(baseline.filter((b) => b.side === 'under')),
  },
  ruleBanOver: {
    ...deltaSummary(ruleKept, baseline),
    cutN: cutRule.length,
    cutOver: summarize(cutRule),
    cutLowTotalShare:
      cutRule.length === 0
        ? null
        : Number(
            (
              cutRule.filter((b) => b.total <= 6).length / cutRule.length
            ).toFixed(3)
          ),
  },
  dualBanOver: {
    ...deltaSummary(dualKept, baseline),
    cutN: cutDual.length,
    cutOver: summarize(cutDual),
    llmCoverage: withLlm.length,
  },
  dualBanOverOnLlmSubsetOnly: {
    baselineSubset: summarize(withLlm),
    ...deltaSummary(dualOnLlmSubsetKept, withLlm),
    cutN: withLlm.filter((b) => b.side === 'over' && b.duel && b.llmDuel).length,
  },
  strongHomeAmongPool: {
    n: pool.filter((b) => b.strongHome).length,
    note: '仅标注；本回放不改独赢选边',
  },
  sampleCuts: cutRule.slice(0, 12).map((b) => ({
    year: b.year,
    matchup: b.matchup,
    pick: `大 ${b.line}`,
    total: b.total,
    result: b.result,
    eras: b.eras,
    llmDuel: b.llmDuel,
  })),
  recommend: null,
};

const ruleOk =
  (out.ruleBanOver.dUsd ?? -1) >= 0 &&
  (out.ruleBanOver.dHrPp ?? -1) >= 0 &&
  (out.ruleBanOver.byYearDeltaUsd?.['2025'] ?? -999) >= -80;
const dualOk =
  out.dualBanOver.cutN >= 5 &&
  (out.dualBanOver.dUsd ?? -1) >= 0 &&
  (out.dualBanOver.dHrPp ?? -1) >= 0;

out.recommend = {
  applyMode: ruleOk ? 'apply_rule_ban_over' : dualOk ? 'apply_dual_ban_over' : 'keep_compare',
  reason: ruleOk
    ? '规则禁大分：Δ$与Δ胜率不差，可正式套用'
    : dualOk
      ? '双确认禁大分更稳，建议 apply + 赛前 LLM'
      : '历史回放未过关，先 compare 继续标语料',
  ruleOk,
  dualOk,
};

fs.writeFileSync(
  new URL('../tmp-game-shape-replay.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify({
  baseline: out.baseline.all,
  ruleBanOver: {
    cutN: out.ruleBanOver.cutN,
    dHrPp: out.ruleBanOver.dHrPp,
    dUsd: out.ruleBanOver.dUsd,
    byYear: out.ruleBanOver.byYearDeltaUsd,
    cutHr: out.ruleBanOver.cutOver.hr,
  },
  dualBanOver: {
    cutN: out.dualBanOver.cutN,
    dHrPp: out.dualBanOver.dHrPp,
    dUsd: out.dualBanOver.dUsd,
    llmCoverage: out.dualBanOver.llmCoverage,
  },
  recommend: out.recommend,
}, null, 2));
console.log('wrote tmp-game-shape-replay.json');
