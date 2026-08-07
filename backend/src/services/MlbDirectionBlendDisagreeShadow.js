/**
 * 方向影子：blend_disagree_only（μ 與勝方頭／市場分歧時混合機率）
 *
 * 正式鎖定 B 選邊不變。預設僅 compare；apply 會被降級成 compare（未過升格閘）。
 *
 * 環境：MLB_DIRECTION_BLEND_SHADOW=off|compare（預設 compare）
 *
 * 證據：auditMlbDirectionAccuracyRound3 → blend_disagree_only
 * 活體：若有 data/mlb-direction-logistic-freeze.json 用凍結 logistic；否則 pL≈pMkt（μ↔市場代理）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { attachDailyResearchRanks } from './MlbResearchRanker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FREEZE_PATH = path.join(__dirname, '../../data/mlb-direction-logistic-freeze.json');

export const MLB_DIRECTION_BLEND_DISAGREE_SPEC = Object.freeze({
  id: 'blend_disagree_only',
  openedAt: '2026-08-07',
  role: 'compare_only_shadow',
  wMu: 0.34,
  wLog: 0.33,
  wMkt: 0.33,
  evidence: Object.freeze({
    artifact: 'tmp-direction-accuracy-round3.json',
    note:
      'holdout+WF 方向過閘；2026 鎖定 B 美元曾變差 → 禁止 apply。活體僅對照。',
  }),
  note:
    'μ 與 logistic／市場方向一致→用 μ；分歧→0.34μ+0.33log+0.33mkt。不改正式選邊／紙上。',
});

export function resolveDirectionBlendShadowMode(
  raw = config.mlbDirectionBlendShadowMode
) {
  const v = String(raw || 'compare').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  // 未過升格閘：apply 一律當 compare
  if (v === 'apply') return 'compare';
  if (v === 'compare' || v === 'shadow' || v === 'on' || v === 'true' || v === '1') {
    return 'compare';
  }
  return 'compare';
}

function sigmoid(z) {
  if (z >= 20) return 1;
  if (z <= -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function loadLogisticFreeze() {
  try {
    if (!fs.existsSync(FREEZE_PATH)) return null;
    const j = JSON.parse(fs.readFileSync(FREEZE_PATH, 'utf8'));
    if (!Array.isArray(j?.w) || !Array.isArray(j?.mean) || !Array.isArray(j?.scale)) {
      return null;
    }
    return j;
  } catch {
    return null;
  }
}

function xMuHeadFromGame(game, pMuHome) {
  const pred = game?.expectedRuns?.prediction;
  const feat = game?.expectedRuns?.features || {};
  const homeMu = Number(pred?.homeExpectedRuns);
  const awayMu = Number(pred?.awayExpectedRuns);
  const homeWinPct = Number(
    feat?.home?.homeWinPct ??
      game?.expectedRuns?.moneylineClassification?.homeWinPct ??
      0.5
  );
  const awayWinPct = Number(feat?.away?.awayWinPct ?? feat?.away?.winPct ?? 0.5);
  const homeSeason = Number(feat?.home?.winPct ?? homeWinPct);
  const awaySeason = Number(feat?.away?.winPct ?? awayWinPct);
  const parkFactor = Number(feat?.parkFactor ?? pred?.parkFactor ?? 1);
  const muMargin =
    Number.isFinite(homeMu) && Number.isFinite(awayMu) ? homeMu - awayMu : 0;
  return [
    muMargin,
    Number(pMuHome),
    Number.isFinite(homeWinPct) ? homeWinPct : 0.5,
    Number.isFinite(awayWinPct) ? awayWinPct : 0.5,
    (Number.isFinite(homeWinPct) ? homeWinPct : 0.5) -
      (Number.isFinite(awayWinPct) ? awayWinPct : 0.5),
    (Number.isFinite(homeSeason) ? homeSeason : 0.5) -
      (Number.isFinite(awaySeason) ? awaySeason : 0.5),
    Number.isFinite(parkFactor) ? parkFactor : 1,
    Number.isFinite(homeMu) ? homeMu : 4.5,
    Number.isFinite(awayMu) ? awayMu : 4.5,
  ];
}

function predictLogisticP(freeze, x) {
  if (!freeze || !x || x.length !== freeze.w.length) return null;
  let z = Number(freeze.b) || 0;
  for (let i = 0; i < x.length; i += 1) {
    const scale = Math.max(0.01, Number(freeze.scale[i]) || 1);
    const zi = (Number(x[i]) - Number(freeze.mean[i] || 0)) / scale;
    z += Number(freeze.w[i] || 0) * zi;
  }
  return sigmoid(z);
}

function readHomeProbs(game) {
  const ml = game?.expectedRuns?.moneylineClassification;
  const pred = game?.expectedRuns?.prediction;
  let pMuHome = Number(
    pred?.markets?.homeWinProbability ?? pred?.homeWinProbability
  );
  if (!Number.isFinite(pMuHome) && ml) {
    const p = Number(ml.modelProbability);
    if (Number.isFinite(p)) {
      pMuHome = ml.side === 'home' ? p : 1 - p;
    }
  }
  let pMktHome = Number(
    ml?.homeMarketProbability ??
      pred?.markets?.homeMarketProbability ??
      ml?.marketProbability
  );
  if (!Number.isFinite(pMktHome) && ml) {
    const mp = Number(ml.marketProbability);
    if (Number.isFinite(mp)) {
      pMktHome = ml.side === 'home' ? mp : 1 - mp;
    }
  }
  const homeOdds = Number(ml?.homeOdds);
  const awayOdds = Number(ml?.awayOdds);
  return {
    pMuHome: Number.isFinite(pMuHome) ? pMuHome : null,
    pMktHome: Number.isFinite(pMktHome) ? pMktHome : null,
    homeOdds: Number.isFinite(homeOdds) ? homeOdds : null,
    awayOdds: Number.isFinite(awayOdds) ? awayOdds : null,
    ml,
  };
}

/**
 * @returns {{ overridden: boolean, pickHome: boolean, pHome: number, pLog: number|null, source: string }|null}
 */
export function decideBlendDisagree(game, freeze = loadLogisticFreeze()) {
  const { pMuHome, pMktHome } = readHomeProbs(game);
  if (pMuHome == null) return null;
  const muHome = pMuHome >= 0.5;
  const x = xMuHeadFromGame(game, pMuHome);
  let pLog = predictLogisticP(freeze, x);
  let source = 'logistic_freeze';
  if (pLog == null) {
    if (pMktHome == null) return null;
    pLog = pMktHome;
    source = 'mkt_proxy_for_log';
  }
  const logHome = pLog >= 0.5;
  const spec = MLB_DIRECTION_BLEND_DISAGREE_SPEC;
  if (muHome === logHome) {
    return {
      overridden: false,
      pickHome: muHome,
      pHome: pMuHome,
      pLog,
      pMktHome,
      source,
    };
  }
  const pM = pMktHome ?? pLog;
  const pHome = spec.wMu * pMuHome + spec.wLog * pLog + spec.wMkt * pM;
  return {
    overridden: true,
    pickHome: pHome >= 0.5,
    pHome,
    pLog,
    pMktHome: pM,
    source,
  };
}

function patchClassification(game, decision) {
  const ml = game?.expectedRuns?.moneylineClassification;
  if (!ml || !decision) return game;
  const { homeOdds, awayOdds } = readHomeProbs(game);
  const pickHome = decision.pickHome;
  const odds = pickHome ? homeOdds : awayOdds;
  const modelProb = pickHome ? decision.pHome : 1 - decision.pHome;
  let marketProb = null;
  if (pickHome && Number.isFinite(homeOdds)) marketProb = 1 / homeOdds;
  if (!pickHome && Number.isFinite(awayOdds)) marketProb = 1 / awayOdds;
  let expectedValue = null;
  if (Number.isFinite(modelProb) && Number.isFinite(odds) && odds > 1) {
    expectedValue = modelProb * (odds - 1) - (1 - modelProb);
  }
  const side = pickHome ? 'home' : 'away';
  const pick = pickHome ? game.homeTeam : game.awayTeam;
  return {
    ...game,
    expectedRuns: {
      ...game.expectedRuns,
      moneylineClassification: {
        ...ml,
        side,
        odds,
        modelProbability: modelProb,
        marketProbability: marketProb,
        expectedValue,
        edge:
          Number.isFinite(modelProb) && Number.isFinite(marketProb)
            ? modelProb - marketProb
            : ml.edge,
        pick,
        directionBlendApplied: decision.overridden,
        directionBlendSource: decision.source,
        directionBlendPHome: decision.pHome,
        reasons: decision.overridden
          ? [...(ml.reasons || []), 'direction_blend_disagree_override']
          : ml.reasons,
      },
    },
    research: game.research
      ? {
          ...game.research,
          pick,
          oddsDecimal: odds,
          modelProb,
          ev: expectedValue,
        }
      : game.research,
  };
}

function summarizeTop(ranked) {
  return (ranked || [])
    .filter(
      (g) =>
        g.researchTier === 'top1_observation' ||
        g.researchTier === 'top3_observation' ||
        g.researchTier === 'strict_observation'
    )
    .slice(0, 12)
    .map((g) => {
      const ml = g.expectedRuns?.moneylineClassification;
      return {
        gameId: g.gameId,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`,
        pick: ml?.side === 'home' ? g.homeTeam : g.awayTeam,
        odds: ml?.odds ?? null,
        ev: ml?.expectedValue ?? null,
        blended: Boolean(ml?.directionBlendApplied),
      };
    });
}

/**
 * 只產生對照；永不改寫正式 ranked（apply 已禁用）。
 */
export function buildDirectionBlendDisagreeShadowSlate(mappedGames, formalRanked) {
  const mode = resolveDirectionBlendShadowMode();
  const spec = MLB_DIRECTION_BLEND_DISAGREE_SPEC;
  const freeze = loadLogisticFreeze();
  if (mode === 'off') {
    return {
      mode: 'off',
      enabled: false,
      appliesToVisiblePicks: false,
      spec,
      logisticFreezeLoaded: Boolean(freeze),
      diff: [],
      shadowTop: [],
      formalTop: summarizeTop(formalRanked),
      ranked: formalRanked,
    };
  }

  const diff = [];
  const patched = (mappedGames || []).map((game) => {
    const decision = decideBlendDisagree(game, freeze);
    if (!decision) return game;
    if (decision.overridden) {
      const ml = game.expectedRuns?.moneylineClassification;
      const fromHome = ml?.side === 'home';
      diff.push({
        gameId: game.gameId,
        matchup: `${game.awayTeam} @ ${game.homeTeam}`,
        from: {
          side: ml?.side,
          pick: fromHome ? game.homeTeam : game.awayTeam,
          pMuHome: readHomeProbs(game).pMuHome,
        },
        to: {
          side: decision.pickHome ? 'home' : 'away',
          pick: decision.pickHome ? game.homeTeam : game.awayTeam,
          pHome: Number(decision.pHome.toFixed(4)),
        },
        source: decision.source,
        sideFlipped: fromHome !== decision.pickHome,
      });
    }
    return patchClassification(game, decision);
  });

  const shadowRanked = attachDailyResearchRanks(patched);
  const formalTop = summarizeTop(formalRanked);
  const shadowTop = summarizeTop(shadowRanked);
  const formalIds = new Set(formalTop.map((x) => x.gameId));
  const shadowIds = new Set(shadowTop.map((x) => x.gameId));

  return {
    mode: 'compare',
    enabled: true,
    appliesToVisiblePicks: false,
    spec,
    logisticFreezeLoaded: Boolean(freeze),
    logisticFreezePath: freeze ? 'data/mlb-direction-logistic-freeze.json' : null,
    evidence: spec.evidence,
    ranked: formalRanked,
    shadowRanked,
    formalTop,
    shadowTop,
    diff,
    slotDiff: {
      sameSlots: formalIds.size === shadowIds.size && [...formalIds].every((id) => shadowIds.has(id)),
      added: shadowTop.filter((x) => !formalIds.has(x.gameId)),
      dropped: formalTop.filter((x) => !shadowIds.has(x.gameId)),
      overrides: diff.length,
      sideFlips: diff.filter((d) => d.sideFlipped).length,
    },
    note:
      '方向 blend 影子對照中：下方可看選邊仍為鎖定 B；差異見 diff／shadowDailyTop。禁止 apply。',
  };
}
