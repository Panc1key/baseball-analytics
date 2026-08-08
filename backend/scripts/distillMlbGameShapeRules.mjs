/**
 * 从 LLM 形态语料蒸馏规则阈值 + 双确认效果
 *
 *   node scripts/distillMlbGameShapeRules.mjs
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { GAME_SHAPE_PROMPT_VERSION } from '../src/services/MlbGameShapeLlmService.js';

function finite(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const rows = db
  .prepare(
    `SELECT facts_json, label_json FROM mlb_game_shape_llm_cache
     WHERE prompt_version = ? AND status = 'ok'`
  )
  .all(GAME_SHAPE_PROMPT_VERSION);

const data = rows
  .map((r) => {
    const f = JSON.parse(r.facts_json);
    const l = JSON.parse(r.label_json);
    const homeEra = finite(f.homeEra);
    const awayEra = finite(f.awayEra);
    const line = finite(f.totalsLine);
    const homeRpg = finite(f.homeRpg);
    const awayRpg = finite(f.awayRpg);
    const homeOdds = finite(f.homeOdds);
    const totalRuns = finite(f.totalRuns);
    if (homeEra == null || awayEra == null || totalRuns == null) return null;
    return {
      homeEra,
      awayEra,
      maxEra: Math.max(homeEra, awayEra),
      line,
      avgRpg:
        homeRpg != null && awayRpg != null ? (homeRpg + awayRpg) / 2 : null,
      homeOdds,
      totalRuns,
      homeWon: Boolean(f.homeWon),
      lowTotal: totalRuns <= 6,
      llmDuel: Boolean(l.pitcher_duel),
      llmHome: Boolean(l.strong_home),
      conf: finite(l.confidence, 0),
    };
  })
  .filter(Boolean);

function evalRule(predFn) {
  const yes = data.filter(predFn);
  const tp = yes.filter((r) => r.lowTotal);
  const meanTotal = yes.length
    ? yes.reduce((s, r) => s + r.totalRuns, 0) / yes.length
    : null;
  return {
    n: yes.length,
    precision: yes.length ? tp.length / yes.length : null,
    meanTotal,
    liftVsAll:
      meanTotal == null
        ? null
        : meanTotal -
          data.reduce((s, r) => s + r.totalRuns, 0) / Math.max(1, data.length),
  };
}

const baselineMean =
  data.reduce((s, r) => s + r.totalRuns, 0) / Math.max(1, data.length);

const grid = [];
for (const maxEra of [3.8, 4.0, 4.25, 4.5]) {
  for (const maxLine of [7, 7.5, 8, 8.5]) {
    for (const maxRpg of [4.8, 5.0, 5.2, 5.5, 99]) {
      const id = `era${maxEra}_line${maxLine}_rpg${maxRpg}`;
      const ruleOnly = evalRule(
        (r) =>
          r.maxEra <= maxEra &&
          r.line != null &&
          r.line <= maxLine &&
          (maxRpg >= 99 || (r.avgRpg != null && r.avgRpg <= maxRpg))
      );
      const dual = evalRule(
        (r) =>
          r.llmDuel &&
          r.maxEra <= maxEra &&
          r.line != null &&
          r.line <= maxLine &&
          (maxRpg >= 99 || (r.avgRpg != null && r.avgRpg <= maxRpg))
      );
      grid.push({
        id,
        maxEra,
        maxLine,
        maxRpg,
        ruleOnly,
        dual,
        score:
          (dual.n >= 15 ? 0 : -100) +
          (dual.meanTotal != null ? baselineMean - dual.meanTotal : -10) * 10 +
          (dual.precision || 0) * 5,
      });
    }
  }
}
grid.sort((a, b) => b.score - a.score);

const llmDuelStats = evalRule((r) => r.llmDuel);
const llmDuelHighConfStats = evalRule((r) => r.llmDuel && r.conf >= 0.55);

function evalHome(predFn) {
  const yes = data.filter(predFn);
  return {
    n: yes.length,
    homeWinRate: yes.length ? yes.filter((r) => r.homeWon).length / yes.length : null,
  };
}

const homeGrid = [];
for (const maxOdds of [1.55, 1.65, 1.75, 1.85]) {
  for (const maxHomeEraWorse of [0.2, 0.4, 0.6]) {
    const id = `odds${maxOdds}_eraWorse${maxHomeEraWorse}`;
    const rule = evalHome(
      (r) =>
        r.homeOdds != null &&
        r.homeOdds <= maxOdds &&
        r.homeEra <= r.awayEra + maxHomeEraWorse
    );
    const dual = evalHome(
      (r) =>
        r.llmHome &&
        r.homeOdds != null &&
        r.homeOdds <= maxOdds &&
        r.homeEra <= r.awayEra + maxHomeEraWorse
    );
    homeGrid.push({
      id,
      maxOdds,
      maxHomeEraWorse,
      rule,
      dual,
      score: (dual.n >= 20 ? 0 : -50) + ((dual.homeWinRate || 0) - 0.5) * 100,
    });
  }
}
homeGrid.sort((a, b) => b.score - a.score);

const recommendDuel =
  grid.find(
    (g) => g.dual.n >= 20 && (g.dual.meanTotal ?? 99) < baselineMean - 0.8
  ) || grid[0];

const out = {
  n: data.length,
  baselineMeanTotal: baselineMean,
  baselineHomeWinRate:
    data.filter((r) => r.homeWon).length / Math.max(1, data.length),
  llmDuelStats,
  llmDuelHighConfStats,
  topDuelRules: grid.slice(0, 12),
  recommendDuel,
  topStrongHome: homeGrid.slice(0, 8),
  recommendHome: homeGrid[0],
  plain: {
    goal: 'find pitcher-duel thresholds with lower mean total',
    advice: 'rule screen + LLM agree before ban over',
  },
};

fs.writeFileSync(
  new URL('../tmp-game-shape-distill.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
console.log(
  JSON.stringify(
    {
      n: out.n,
      baselineMeanTotal: Number(out.baselineMeanTotal.toFixed(2)),
      llmDuelStats: out.llmDuelStats,
      recommendDuel: out.recommendDuel,
      recommendHome: out.recommendHome,
    },
    null,
    2
  )
);
console.log('wrote tmp-game-shape-distill.json');
