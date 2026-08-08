/**
 * MLB 分層架構契約（業務基準 SSOT）
 *
 * 四層：類型 Type → 路由 Route → 估分 μ → 定价 Price
 * 之後所有 MLB 改動必須聲明所屬層；禁止跨層連坐、禁止再平行發明「像不像对决」。
 *
 * 文件：docs/expansion/MLB-LAYERED-ARCHITECTURE.md
 */
import {
  detectPitcherDuel,
  detectStrongHome,
  MLB_GAME_SHAPE_SHADOW_SPEC,
  readStarterEras,
  resolveGameShapeShadowMode,
} from './MlbGameShapeShadow.js';
import { getCachedGameShapeLabel } from './MlbGameShapeLlmService.js';
import {
  MLB_STRONG_HOME_SOFT_SPEC,
  resolveStrongHomeSoftMode,
} from './MlbStrongHomeSoftShadow.js';
import {
  MLB_DUEL_ML_SOFT_SPEC,
  resolveDuelMlSoftMode,
} from './MlbDuelMlSoftShadow.js';
import {
  MLB_UNCLEAR_REDUCE_SPEC,
  resolveUnclearReduceMode,
} from './MlbUnclearReduceShadow.js';

export const MLB_LAYERED_ARCHITECTURE_VERSION = 'mlb-layered-arch-v1';
export const MLB_LAYERED_ARCHITECTURE_OPENED_AT = '2026-08-08';

/** 第 0 级：四層 */
export const MLB_ARCHITECTURE_LAYERS = Object.freeze([
  'type',
  'route',
  'mu',
  'price',
]);

/** ① 類型主標籤 */
export const MLB_GAME_TYPES = Object.freeze([
  'pitcher_duel',
  'strong_home',
  'offense_game',
  'normal',
  'unclear',
]);

/**
 * 第 1 级：類型子判定器（可單獨回測分離度）
 * 參數級旋鈕不算獨立產品模組。
 */
export const MLB_TYPE_DETECTORS = Object.freeze({
  T1_pitcher_duel: Object.freeze({
    id: 'T1_pitcher_duel',
    asks: '雙先發穩不穩 + 總分線低不低',
    moduleHint: 'MlbGameShapeShadow.detectPitcherDuel',
  }),
  T2_strong_home: Object.freeze({
    id: 'T2_strong_home',
    asks: '主勝賠短不短 + 先發崩不崩',
    moduleHint: 'MlbGameShapeShadow.detectStrongHome',
  }),
  T3_offense_blowup: Object.freeze({
    id: 'T3_offense_blowup',
    asks: '打線吵不吵、先發爆不爆（可選）',
    moduleHint: 'future / regime high_total signals',
    enabled: false,
  }),
  T4_unclear: Object.freeze({
    id: 'T4_unclear',
    asks: '缺 ERA / 缺線 → unclear',
    moduleHint: 'resolveMlbGameType missing-data branch',
  }),
  T4b_missing_either_era: Object.freeze({
    id: 'T4b_missing_either_era',
    asks: '缺任一邊 ERA（寬標籤，不改正式 type）',
    moduleHint: 'MlbMissingEraSoftShadow / detectUnclearBreadth(wide)',
    overridesFormalType: false,
    status: 'compare',
    evidence: 'tmp-t4-wide-type-separation.json PROMOTE_COMPARE_SHADOW_ONLY',
  }),
  T5_llm_vote: Object.freeze({
    id: 'T5_llm_vote',
    asks: 'LLM 形態票（只投票，不否決 T1–T4）',
    moduleHint: 'MlbGameShapeLlmService cache',
    overridesRules: false,
  }),
});

/**
 * 第 1 级：路由動作（一條一個開關、單獨回測）
 */
export const MLB_ROUTE_ACTIONS = Object.freeze({
  R1_ban_totals_over: Object.freeze({
    id: 'R1_ban_totals_over',
    market: 'totals',
    effect: 'ban_over',
    whenTypes: Object.freeze(['pitcher_duel']),
    status: 'apply',
    evidence: 'tmp-game-shape-replay.json ruleBanOver +$89.5 / +0.63pp',
  }),
  R2_lean_totals_under: Object.freeze({
    id: 'R2_lean_totals_under',
    market: 'totals',
    effect: 'lean_under',
    whenTypes: Object.freeze(['pitcher_duel']),
    status: 'lean_only',
    evidence: 'display / research; not auto-flip under',
  }),
  R3_moneyline_demote_duel: Object.freeze({
    id: 'R3_moneyline_demote_duel',
    market: 'moneyline',
    effect: 'rank_demote',
    whenTypes: Object.freeze(['pitcher_duel']),
    status: 'compare',
    evidence:
      'tmp-duel-ml-soft-on-locked-b.json best +$134.5 but 2024 −$146; gate failed',
  }),
  R4_moneyline_soft_demote_away_vs_strong_home: Object.freeze({
    id: 'R4_moneyline_soft_demote_away_vs_strong_home',
    market: 'moneyline',
    effect: 'rank_soft_penalty',
    whenTypes: Object.freeze(['strong_home']),
    status: 'compare',
    evidence:
      'tmp-strong-home-soft-on-locked-b.json best +$91 but 2025 -$145; gate failed',
  }),
  R5_unclear_reduce_volume: Object.freeze({
    id: 'R5_unclear_reduce_volume',
    market: 'both',
    effect: 'reduce_volume',
    whenTypes: Object.freeze(['unclear']),
    status: 'compare',
    evidence:
      'tmp-unclear-reduce-on-locked-b.json strict n=0; wide shadow +$278 not formal T4',
  }),
  R6_normal_passthrough: Object.freeze({
    id: 'R6_normal_passthrough',
    market: 'both',
    effect: 'passthrough',
    whenTypes: Object.freeze(['normal', 'offense_game']),
    status: 'apply',
    evidence: 'default Locked B + Hybrid',
  }),
});

export const MLB_LAYER_OWNERS = Object.freeze({
  type: Object.freeze({
    layer: 'type',
    mayChange: Object.freeze([
      'resolveMlbGameType',
      'MlbGameShapeShadow detectors',
      'MlbGameShapeLlmService vote only',
    ]),
    mustNotChange: Object.freeze([
      'predictMlbGameRuns weights',
      'Locked B EV thresholds as type fix',
    ]),
    acceptMetric: 'type separation (mean total / home win rate by label)',
  }),
  route: Object.freeze({
    layer: 'route',
    mayChange: Object.freeze([
      'resolveMlbMarketRoute',
      'R1–R6 action flags',
      'strong-home soft rank (compare→apply gate)',
    ]),
    mustNotChange: Object.freeze(['μ training', 'invent parallel duel detectors']),
    acceptMetric: 'structure-error down + Δ$ / ΔHR with year stability',
  }),
  mu: Object.freeze({
    layer: 'mu',
    mayChange: Object.freeze([
      'predictMlbGameRuns / explainMlbExpectedRunsMean',
      'frozen_b residual (separate freeze)',
    ]),
    mustNotChange: Object.freeze([
      'routing policy disguised as feature tweak without type layer',
    ]),
    acceptMetric: 'MAE / direction / calibration; not TopK ROI alone',
  }),
  price: Object.freeze({
    layer: 'price',
    mayChange: Object.freeze([
      'classifyMlbMoneylineCandidate',
      'MlbResearchRanker TopK',
      'classifyMlbTotalsHybridCandidate',
    ]),
    mustNotChange: Object.freeze(['redefining game type inside EV gates']),
    acceptMetric: 'Locked B / Hybrid ROI under fixed type+route',
  }),
});

function finite(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readRpg(side) {
  return finite(side?.recentRunsPerGame, finite(side?.runsPerGame));
}

/**
 * ① 類型層統一出口
 */
export function resolveMlbGameType({
  features,
  totalsLine = null,
  homeOdds = null,
  gameId = null,
  llmLabel = null,
} = {}) {
  const eras = readStarterEras(features || {});
  const line = finite(totalsLine);
  const missingEra = eras.homeEra == null || eras.awayEra == null;

  const t1 = detectPitcherDuel(features, {
    totalsLine: line,
    spec: MLB_GAME_SHAPE_SHADOW_SPEC,
  });
  const t2 = detectStrongHome(features, {
    homeOdds,
    spec: MLB_GAME_SHAPE_SHADOW_SPEC,
  });

  let llm = llmLabel;
  if (!llm && gameId) llm = getCachedGameShapeLabel(gameId);

  const homeRpg = readRpg(features?.home);
  const awayRpg = readRpg(features?.away);
  const avgRpg =
    homeRpg != null && awayRpg != null ? (homeRpg + awayRpg) / 2 : null;
  const t3Offense =
    avgRpg != null &&
    avgRpg >= 5.8 &&
    (eras.homeEra == null || eras.homeEra >= 4.8) &&
    (eras.awayEra == null || eras.awayEra >= 4.8);

  /** 優先級：缺數 unclear → 對決 → 強主 → 高打(可選) → normal */
  let type = 'normal';
  let primaryDetector = 'T_none';
  if (missingEra && line == null) {
    type = 'unclear';
    primaryDetector = 'T4_unclear';
  } else if (t1.matched) {
    type = 'pitcher_duel';
    primaryDetector = 'T1_pitcher_duel';
  } else if (t2.matched) {
    type = 'strong_home';
    primaryDetector = 'T2_strong_home';
  } else if (t3Offense) {
    type = 'offense_game';
    primaryDetector = 'T3_offense_blowup';
  }

  const confidence =
    type === 'unclear'
      ? 0.2
      : type === 'pitcher_duel' || type === 'strong_home'
        ? 0.75
        : type === 'offense_game'
          ? 0.45
          : 0.5;

  return {
    version: MLB_LAYERED_ARCHITECTURE_VERSION,
    layer: 'type',
    type,
    confidence,
    primaryDetector,
    detectors: {
      T1_pitcher_duel: t1,
      T2_strong_home: t2,
      T3_offense_blowup: {
        matched: Boolean(t3Offense),
        avgRpg,
        enabled: MLB_TYPE_DETECTORS.T3_offense_blowup.enabled !== false,
      },
      T4_unclear: { matched: type === 'unclear', missingEra, lineMissing: line == null },
      T5_llm_vote: llm
        ? {
            pitcherDuel: Boolean(llm.pitcher_duel),
            strongHome: Boolean(llm.strong_home),
            confidence: llm.confidence ?? null,
            reason: llm.reason || null,
            overridesRules: false,
          }
        : null,
    },
    signals: {
      homeEra: eras.homeEra,
      awayEra: eras.awayEra,
      totalsLine: line,
      homeOdds: finite(homeOdds),
      homeRpg,
      awayRpg,
    },
  };
}

/**
 * ② 路由層：只讀 type，輸出動作（不改 μ）
 */
export function resolveMlbMarketRoute(gameTypeResult, { modes = {} } = {}) {
  const type = gameTypeResult?.type || 'unclear';
  const shapeMode = modes.gameShape ?? resolveGameShapeShadowMode();
  const strongSoftMode = modes.strongHomeSoft ?? resolveStrongHomeSoftMode();
  const duelMlMode = modes.duelMlSoft ?? resolveDuelMlSoftMode();
  const unclearMode = modes.unclearReduce ?? resolveUnclearReduceMode();

  const actions = [];
  const bans = [];
  const leans = [];
  const rankPenalties = [];

  if (type === 'pitcher_duel') {
    if (shapeMode !== 'off') {
      actions.push(MLB_ROUTE_ACTIONS.R1_ban_totals_over.id);
      bans.push('totals_over');
      actions.push(MLB_ROUTE_ACTIONS.R2_lean_totals_under.id);
      leans.push('totals_under');
    }
    actions.push(MLB_ROUTE_ACTIONS.R3_moneyline_demote_duel.id);
    if (duelMlMode === 'apply') {
      rankPenalties.push({
        id: 'R3',
        when: 'any_moneyline',
        lambda: MLB_DUEL_ML_SOFT_SPEC.rankPenaltyLambda,
      });
    }
  }

  if (type === 'strong_home') {
    actions.push(MLB_ROUTE_ACTIONS.R4_moneyline_soft_demote_away_vs_strong_home.id);
    if (strongSoftMode === 'apply') {
      rankPenalties.push({
        id: 'R4',
        when: 'away_pick',
        lambda: MLB_STRONG_HOME_SOFT_SPEC.rankPenaltyLambda,
      });
    }
  }

  if (type === 'unclear') {
    actions.push(MLB_ROUTE_ACTIONS.R5_unclear_reduce_volume.id);
    if (unclearMode === 'apply') {
      rankPenalties.push({
        id: 'R5',
        when: 'any_market',
        lambda: MLB_UNCLEAR_REDUCE_SPEC.rankPenaltyLambda,
        hardSkip: Boolean(MLB_UNCLEAR_REDUCE_SPEC.hardSkipFromTopK),
      });
    }
  }

  if (type === 'normal' || type === 'offense_game') {
    actions.push(MLB_ROUTE_ACTIONS.R6_normal_passthrough.id);
  }

  return {
    version: MLB_LAYERED_ARCHITECTURE_VERSION,
    layer: 'route',
    type,
    actions,
    bans,
    leans,
    rankPenalties,
    modes: {
      gameShape: shapeMode,
      strongHomeSoft: strongSoftMode,
      duelMlSoft: duelMlMode,
      unclearReduce: unclearMode,
    },
    plain:
      type === 'pitcher_duel'
        ? '類型=投手戰：禁大分；可偏小球；獨贏軟降權（R3 compare/過關 apply）'
        : type === 'strong_home'
          ? '類型=強主：客勝軟降權（compare/過關才 apply）；不硬切'
          : type === 'unclear'
            ? '類型=不明：少推（R5 compare/過關 apply）'
            : '類型=普通/高打：Locked B + Hybrid 放行',
  };
}

/**
 * 一次產出類型+路由（Pipeline / 審計共用）
 */
export function buildMlbLayeredDecision({
  features,
  totalsLine = null,
  homeOdds = null,
  gameId = null,
  llmLabel = null,
} = {}) {
  const gameType = resolveMlbGameType({
    features,
    totalsLine,
    homeOdds,
    gameId,
    llmLabel,
  });
  const route = resolveMlbMarketRoute(gameType);
  return {
    version: MLB_LAYERED_ARCHITECTURE_VERSION,
    openedAt: MLB_LAYERED_ARCHITECTURE_OPENED_AT,
    layers: MLB_ARCHITECTURE_LAYERS,
    gameType,
    route,
    contract: {
      doc: 'docs/expansion/MLB-LAYERED-ARCHITECTURE.md',
      rule: '改動必須聲明 type|route|mu|price；類型/路由未統一前禁止平行發明對決認定',
    },
  };
}

export function describeMlbLayeredArchitecture() {
  return {
    version: MLB_LAYERED_ARCHITECTURE_VERSION,
    openedAt: MLB_LAYERED_ARCHITECTURE_OPENED_AT,
    layers: MLB_ARCHITECTURE_LAYERS,
    types: MLB_GAME_TYPES,
    detectors: MLB_TYPE_DETECTORS,
    routeActions: MLB_ROUTE_ACTIONS,
    layerOwners: MLB_LAYER_OWNERS,
    doc: 'docs/expansion/MLB-LAYERED-ARCHITECTURE.md',
  };
}
