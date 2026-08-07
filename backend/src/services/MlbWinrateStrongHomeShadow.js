/**
 * 提勝率影子：強主場下推客 → 改推主（或剔除）
 *
 * 證據：auditMlbWinrateLiftShadow / tmp-winrate-lift-shadow.json
 * - flip_hwp062_ev10_rall：Δ勝率 +1.37pp、Δ$+294，可蓋 hwp≈0.62（釀酒人類）
 * - 正式毒客 shrink 仍為 0.65，蓋不住 0.625
 *
 * MLB_WINRATE_STRONG_HOME_SHADOW=off|compare|apply（預設 apply）
 * MLB_WINRATE_STRONG_HOME_ACTION=flip|skip（預設 skip：屏蔽優於硬翻）
 */
import { config } from '../config.js';
import { attachDailyResearchRanks } from './MlbResearchRanker.js';

export const MLB_WINRATE_STRONG_HOME_SPEC = Object.freeze({
  id: 'winrate_strong_home_skip_hwp062_ev10',
  openedAt: '2026-08-07',
  strongHomeWinPct: 0.62,
  minEv: 0.1,
  actionDefault: 'skip',
  evidence: Object.freeze({
    artifact: 'tmp-winrate-lift-shadow.json',
    deltaHitRatePp: 1.59,
    deltaUsd50: 148,
    catchesBrewersLike: true,
    note: 'skip 路徑：不碰毒客切片；翻主另見 ACTION=flip',
  }),
  note:
    '提勝率路徑：客+homeWinPct≥62%+EV≥10% → 預設不下。不改 ev02／frozen_b 0.65 shrink 常數。',
});

export function resolveWinrateStrongHomeMode(
  raw = config.mlbWinrateStrongHomeShadowMode
) {
  const v = String(raw || 'apply').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'compare' || v === 'shadow') return 'compare';
  return 'apply';
}

export function resolveWinrateStrongHomeAction(
  raw = config.mlbWinrateStrongHomeAction
) {
  const v = String(raw || 'skip').trim().toLowerCase();
  return v === 'flip' || v === 'home' ? 'flip' : 'skip';
}

function readHomeWinPct(game) {
  const fromMl = Number(game?.expectedRuns?.moneylineClassification?.homeWinPct);
  if (Number.isFinite(fromMl)) return fromMl;
  const fromOverlay = Number(
    game?.expectedRuns?.prediction?.lockedBOverlay?.homeWinPct
  );
  if (Number.isFinite(fromOverlay)) return fromOverlay;
  const fromFeat = Number(game?.expectedRuns?.features?.home?.homeWinPct);
  if (Number.isFinite(fromFeat)) return fromFeat;
  return null;
}

function readHomeAwayOdds(game) {
  const ml = game?.expectedRuns?.moneylineClassification;
  const homeOdds = Number(ml?.homeOdds);
  const awayOdds = Number(ml?.awayOdds);
  return {
    homeOdds: Number.isFinite(homeOdds) ? homeOdds : null,
    awayOdds: Number.isFinite(awayOdds) ? awayOdds : null,
  };
}

/**
 * @returns {{ matched: boolean, homeWinPct: number|null, ev: number|null }}
 */
export function matchWinrateStrongHomeAway(game, spec = MLB_WINRATE_STRONG_HOME_SPEC) {
  const ml = game?.expectedRuns?.moneylineClassification;
  if (!ml || ml.tier === 'blocked') {
    return { matched: false, homeWinPct: null, ev: null };
  }
  if (ml.side !== 'away') {
    return { matched: false, homeWinPct: readHomeWinPct(game), ev: Number(ml.expectedValue) };
  }
  const homeWinPct = readHomeWinPct(game);
  const ev = Number(ml.expectedValue);
  const matched =
    homeWinPct != null &&
    homeWinPct >= spec.strongHomeWinPct &&
    Number.isFinite(ev) &&
    ev >= spec.minEv;
  return { matched, homeWinPct, ev };
}

function flipClassificationToHome(game, ml, homeOdds) {
  const pred = game?.expectedRuns?.prediction;
  const homeProb = Number(
    pred?.markets?.homeWinProbability ??
      (Number.isFinite(Number(ml.modelProbabilityRaw ?? ml.modelProbability))
        ? 1 - Number(ml.modelProbabilityRaw ?? ml.modelProbability)
        : null)
  );
  const marketProb = Number(
    ml.homeMarketProbability ??
      (Number.isFinite(homeOdds) ? 1 / homeOdds : null)
  );
  const odds = Number(homeOdds);
  const modelProb = Number.isFinite(homeProb) ? homeProb : null;
  let expectedValue = null;
  if (Number.isFinite(modelProb) && Number.isFinite(odds)) {
    expectedValue = modelProb * (odds - 1) - (1 - modelProb);
  }
  const edge =
    Number.isFinite(modelProb) && Number.isFinite(marketProb)
      ? modelProb - marketProb
      : null;

  return {
    ...ml,
    side: 'home',
    odds,
    modelProbability: modelProb,
    marketProbability: marketProb,
    expectedValue,
    edge,
    pick: game.homeTeam,
    winrateStrongHomeFlip: true,
    winrateStrongHomeSpecId: MLB_WINRATE_STRONG_HOME_SPEC.id,
    rawAwaySide: 'away',
    rawAwayOdds: ml.odds,
    rawAwayExpectedValue: ml.expectedValue,
    rawAwayModelProbability: ml.modelProbability,
    reasons: [...(ml.reasons || []), 'winrate_strong_home_flip_to_home'],
  };
}

function demoteClassification(ml) {
  return {
    ...ml,
    tier: 'blocked',
    winrateStrongHomeSkip: true,
    winrateStrongHomeSpecId: MLB_WINRATE_STRONG_HOME_SPEC.id,
    reasons: [...(ml.reasons || []), 'winrate_strong_home_skip_away'],
  };
}

/**
 * 在 high-EV shrink 之後套用；apply 時改寫可看／紙上晉升用的 ranked。
 */
export function buildWinrateStrongHomeShadowSlate(mappedGames, formalRanked) {
  const mode = resolveWinrateStrongHomeMode();
  const action = resolveWinrateStrongHomeAction();
  const spec = MLB_WINRATE_STRONG_HOME_SPEC;
  if (mode === 'off') {
    return {
      mode,
      enabled: false,
      appliesToVisiblePicks: false,
      action,
      spec,
      ranked: formalRanked,
      diff: [],
      shadowTop: [],
    };
  }

  const diff = [];
  const patchedMapped = (mappedGames || []).map((game) => {
    const hit = matchWinrateStrongHomeAway(game, spec);
    if (!hit.matched) return game;
    const ml = game.expectedRuns?.moneylineClassification;
    const { homeOdds, awayOdds } = readHomeAwayOdds(game);
    const entry = {
      gameId: game.gameId,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      homeWinPct: hit.homeWinPct,
      ev: hit.ev,
      action,
      from: { side: 'away', odds: ml?.odds, pick: game.awayTeam },
      to:
        action === 'flip'
          ? { side: 'home', odds: homeOdds, pick: game.homeTeam }
          : { side: null, odds: null, pick: null },
    };
    diff.push(entry);

    if (mode !== 'apply') return game;

    if (action === 'skip') {
      return {
        ...game,
        expectedRuns: {
          ...game.expectedRuns,
          moneylineClassification: demoteClassification(ml),
        },
      };
    }

    if (!Number.isFinite(homeOdds)) {
      return {
        ...game,
        expectedRuns: {
          ...game.expectedRuns,
          moneylineClassification: demoteClassification(ml),
        },
      };
    }

    return {
      ...game,
      expectedRuns: {
        ...game.expectedRuns,
        moneylineClassification: flipClassificationToHome(game, ml, homeOdds),
      },
      research: game.research
        ? {
            ...game.research,
            pick: game.homeTeam,
            oddsDecimal: homeOdds,
          }
        : game.research,
    };
  });

  const ranked =
    mode === 'apply'
      ? attachDailyResearchRanks(patchedMapped)
      : formalRanked;

  const shadowTop = (mode === 'apply' ? ranked : formalRanked)
    .filter(
      (g) =>
        g.researchTier === 'top1_observation' ||
        g.researchTier === 'top3_observation' ||
        g.researchTier === 'strict_observation'
    )
    .slice(0, 12)
    .map((g) => ({
      gameId: g.gameId,
      matchup: `${g.awayTeam} @ ${g.homeTeam}`,
      pick:
        g.expectedRuns?.moneylineClassification?.side === 'home'
          ? g.homeTeam
          : g.awayTeam,
      flipped: Boolean(g.expectedRuns?.moneylineClassification?.winrateStrongHomeFlip),
      skipped: Boolean(g.expectedRuns?.moneylineClassification?.winrateStrongHomeSkip),
    }));

  return {
    mode,
    enabled: true,
    appliesToVisiblePicks: mode === 'apply',
    action,
    spec,
    ranked,
    diff,
    shadowTop,
    awayOddsCheck: diff.length,
  };
}
