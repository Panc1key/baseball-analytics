/**
 * 赛前「比赛形态」影子：投手对决 / 强主。
 * 目标：把「一眼能看出的局」标出来，并给出路由建议（先 compare，不改正式常量）。
 *
 * 大白话：
 * - 投手对决 → 偏小球，别追大分
 * - 强主 → 偏主胜
 */
import { config } from '../config.js';
import { getCachedGameShapeLabel } from './MlbGameShapeLlmService.js';

function finite(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const MLB_GAME_SHAPE_SHADOW_SPEC = Object.freeze({
  id: 'game_shape_pitcher_duel_strong_home_v1',
  openedAt: '2026-08-08',
  role: 'compare_then_apply_if_replay_ok',
  /**
   * 主参数对齐历史更稳刀：线≤7 + 双方 ERA≤4.25
   * （线≤8 会砍到仍赚钱的 Over，回放 Δ$ 为负）
   */
  pitcherDuel: Object.freeze({
    maxStarterEra: 4.25,
    maxTotalLine: 7,
    maxAvgOffenseRpg: 5.5,
  }),
  strongHome: Object.freeze({
    minRpgEdge: 0.6,
    maxHomeEraWorseThanAway: 0.4,
    maxHomeOdds: 1.75,
    minWinPctEdge: 0.08,
  }),
  /** 紧刀（线≤7）规则-only 回放过关；双确认暂因语料覆盖不足不作硬门槛 */
  dualConfirmBanOver: false,
  note: '形态影子 v1：线≤7+双强投禁大分（规则）；强主偏主胜提示。默认可 apply。',
});

export function resolveGameShapeShadowMode(raw = null) {
  const v = String(
    raw ?? config.mlbGameShapeShadowMode ?? process.env.MLB_GAME_SHAPE_SHADOW ?? 'compare'
  )
    .trim()
    .toLowerCase();
  if (v === 'apply' || v === 'on' || v === 'true' || v === '1') return 'apply';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return 'compare';
}

function readRpg(side) {
  return finite(side?.recentRunsPerGame, finite(side?.runsPerGame));
}

function readWinPct(side) {
  const raw = finite(side?.winPct, finite(side?.winningPct, finite(side?.wPct)));
  if (raw == null) {
    const w = finite(side?.wins);
    const l = finite(side?.losses);
    if (w != null && l != null && w + l > 0) return w / (w + l);
    return null;
  }
  return raw > 1 ? raw / 100 : raw;
}

export function readStarterEras(features) {
  const homeEra = finite(
    features?.pitchers?.home?.era,
    finite(features?.pitchers?.homeRecent?.recent3Era)
  );
  const awayEra = finite(
    features?.pitchers?.away?.era,
    finite(features?.pitchers?.awayRecent?.recent3Era)
  );
  return {
    homeEra,
    awayEra,
    homeName: features?.pitchers?.homeIdentity?.name || features?.pitchers?.home?.name || null,
    awayName: features?.pitchers?.awayIdentity?.name || features?.pitchers?.away?.name || null,
  };
}

/**
 * 投手对决：双方先发 ERA 都不差 + 盘口总分开得低（市场也认）+ 打线别两边都疯。
 */
export function detectPitcherDuel(
  features,
  { totalsLine = null, spec = MLB_GAME_SHAPE_SHADOW_SPEC } = {}
) {
  const p = spec.pitcherDuel;
  const { homeEra, awayEra, homeName, awayName } = readStarterEras(features);
  const line = finite(totalsLine);
  const homeRpg = readRpg(features?.home);
  const awayRpg = readRpg(features?.away);
  const avgRpg =
    homeRpg != null && awayRpg != null ? (homeRpg + awayRpg) / 2 : null;

  if (homeEra == null || awayEra == null) {
    return {
      matched: false,
      reason: 'starter_era_missing',
      homeEra,
      awayEra,
      line,
      homeName,
      awayName,
    };
  }
  if (homeEra > p.maxStarterEra || awayEra > p.maxStarterEra) {
    return {
      matched: false,
      reason: 'era_too_high',
      homeEra,
      awayEra,
      line,
      homeName,
      awayName,
    };
  }
  if (line == null) {
    return {
      matched: false,
      reason: 'totals_line_missing',
      homeEra,
      awayEra,
      line,
      homeName,
      awayName,
    };
  }
  if (line > p.maxTotalLine) {
    return {
      matched: false,
      reason: 'line_too_high',
      homeEra,
      awayEra,
      line,
      homeName,
      awayName,
    };
  }
  if (avgRpg != null && avgRpg > p.maxAvgOffenseRpg) {
    return {
      matched: false,
      reason: 'offense_too_loud',
      homeEra,
      awayEra,
      line,
      avgRpg,
      homeName,
      awayName,
    };
  }
  return {
    matched: true,
    reason: 'pitcher_duel',
    homeEra,
    awayEra,
    line,
    avgRpg,
    homeName,
    awayName,
  };
}

/**
 * 强主：市场主胜赔率够低，或（无赔率时）主队近期/胜率明显更好且先发不崩。
 */
export function detectStrongHome(
  features,
  { homeOdds = null, spec = MLB_GAME_SHAPE_SHADOW_SPEC } = {}
) {
  const s = spec.strongHome;
  const { homeEra, awayEra } = readStarterEras(features);
  const homeRpg = readRpg(features?.home);
  const awayRpg = readRpg(features?.away);
  const homeWp = readWinPct(features?.home);
  const awayWp = readWinPct(features?.away);
  const odds = finite(homeOdds);

  const eraOk =
    homeEra == null ||
    awayEra == null ||
    homeEra <= awayEra + s.maxHomeEraWorseThanAway;

  if (odds != null) {
    if (odds <= s.maxHomeOdds && eraOk) {
      return {
        matched: true,
        reason: 'market_strong_home',
        homeOdds: odds,
        homeEra,
        awayEra,
        homeRpg,
        awayRpg,
        homeWp,
        awayWp,
      };
    }
    return {
      matched: false,
      reason: odds > s.maxHomeOdds ? 'home_odds_not_short' : 'home_era_too_weak',
      homeOdds: odds,
      homeEra,
      awayEra,
      homeRpg,
      awayRpg,
      homeWp,
      awayWp,
    };
  }

  const rpgEdge =
    homeRpg != null && awayRpg != null ? homeRpg - awayRpg : null;
  const wpEdge = homeWp != null && awayWp != null ? homeWp - awayWp : null;
  const strongByForm =
    (rpgEdge != null && rpgEdge >= s.minRpgEdge && eraOk) ||
    (wpEdge != null && wpEdge >= s.minWinPctEdge && eraOk);

  if (strongByForm) {
    return {
      matched: true,
      reason: 'form_strong_home',
      homeOdds: null,
      homeEra,
      awayEra,
      homeRpg,
      awayRpg,
      homeWp,
      awayWp,
      rpgEdge,
      wpEdge,
    };
  }
  return {
    matched: false,
    reason: 'not_strong_home',
    homeOdds: null,
    homeEra,
    awayEra,
    homeRpg,
    awayRpg,
    homeWp,
    awayWp,
    rpgEdge,
    wpEdge,
  };
}

export function adviseGameShapeRoutes({ pitcherDuel, strongHome, banOver = null }) {
  const bans = [];
  const leans = [];
  const allowBanOver = banOver == null ? Boolean(pitcherDuel?.matched) : Boolean(banOver);
  if (allowBanOver) {
    bans.push('totals_over');
  }
  if (pitcherDuel?.matched) {
    leans.push('totals_under');
  }
  if (strongHome?.matched) {
    leans.push('home_moneyline');
  }
  return {
    bans,
    leans,
    plain:
      pitcherDuel?.matched && strongHome?.matched
        ? '投手对决 + 强主：偏小球，偏主胜；别追大分。'
        : pitcherDuel?.matched
          ? '投手对决：偏小球；别追大分。'
          : strongHome?.matched
            ? '强主：偏主胜。'
            : '形态不明：别硬推。',
  };
}

export function buildGameShapeShadow({
  features,
  totalsLine = null,
  homeOdds = null,
  mode = null,
  llmLabel = null,
  gameId = null,
  dualConfirmBanOver = null,
} = {}) {
  const resolvedMode = resolveGameShapeShadowMode(mode);
  const pitcherDuel = detectPitcherDuel(features, { totalsLine });
  const strongHome = detectStrongHome(features, { homeOdds });

  let llm = llmLabel;
  if (!llm && gameId) {
    llm = getCachedGameShapeLabel(gameId);
  }

  const useDual =
    dualConfirmBanOver == null
      ? Boolean(config.mlbGameShapeDualConfirm)
      : Boolean(dualConfirmBanOver);

  const llmDuel = Boolean(llm?.pitcher_duel);
  // 双确认：两边都说投手战才禁大分；没有 LLM 标签时先不禁（避免误杀）
  // 若 dualConfirm 关闭：规则命中即可禁
  const banOver = useDual
    ? Boolean(pitcherDuel.matched && llm && llmDuel)
    : pitcherDuel.matched;
  const routes = adviseGameShapeRoutes({
    pitcherDuel,
    strongHome,
    banOver,
  });
  return {
    mode: resolvedMode,
    specId: MLB_GAME_SHAPE_SHADOW_SPEC.id,
    pitcherDuel,
    strongHome,
    llm: llm
      ? {
          pitcherDuel: llmDuel,
          strongHome: Boolean(llm?.strong_home),
          confidence: llm?.confidence ?? null,
          reason: llm?.reason || null,
          cached: Boolean(llm?.cached),
        }
      : null,
    dualConfirmBanOver: Boolean(useDual),
    routes,
    wouldBanOver: routes.bans.includes('totals_over'),
    wouldLeanUnder: routes.leans.includes('totals_under'),
    wouldLeanHome: routes.leans.includes('home_moneyline'),
  };
}

/**
 * Hybrid 候选：compare 只打标；apply 才真跳过 Over。
 */
export function applyGameShapeToTotalsCandidate(
  cls,
  features,
  { totalsLine = null, gameId = null, llmLabel = null } = {}
) {
  const mode = resolveGameShapeShadowMode();
  if (mode === 'off' || !cls || cls.tier !== 'actionable') {
    return cls;
  }
  const line = finite(totalsLine, finite(cls.line));
  const shape = buildGameShapeShadow({
    features,
    totalsLine: line,
    gameId,
    llmLabel,
  });
  if (!shape.wouldBanOver || String(cls.side).toLowerCase() !== 'over') {
    return {
      ...cls,
      gameShapeShadow: shape,
    };
  }
  if (mode === 'compare') {
    return {
      ...cls,
      gameShapeShadow: {
        ...shape,
        wouldSkipOver: true,
      },
    };
  }
  return {
    ...cls,
    tier: 'blocked',
    reasons: [...(cls.reasons || []), 'game_shape_pitcher_duel_ban_over'],
    gameShapeSkipOver: true,
    gameShapeShadow: {
      ...shape,
      wouldSkipOver: true,
      skipped: true,
    },
  };
}
