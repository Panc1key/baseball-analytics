/**
 * 影子 overlay：shrink_w15_l15（高 EV≥8% 輕收縮 + 排序 λ）
 *
 * 狀態：觀察期（不升格正式常數；不改 Locked B / ev02）
 * - off：關閉
 * - compare：計算影子日 Top，正式可看選邊／紙上不變
 * - apply：對可看選邊／紙上晉升套用（仍可一鍵關）；主倉常數仍凍
 *
 * 環境變數：MLB_HIGH_EV_SHRINK_SHADOW=off|compare|apply（預設 compare）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import {
  MLB_MONEYLINE_RULE_PROFILES,
  scoreMlbMoneylineDailyRank,
} from './MlbExpectedRunsModel.js';
import { MLB_FROZEN_B_SHADOW_SPEC } from './MlbFrozenBShadow.js';
import { attachDailyResearchRanks } from './MlbResearchRanker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WF_SNAPSHOT = path.join(__dirname, '../../tmp-cal-high-ev-tail-expanding-wf.json');
const LIVE_SNAPSHOT = path.join(
  __dirname,
  '../../tmp-high-ev-shrink-shadow-observe.json'
);

/** @type {const} */
export const MLB_HIGH_EV_SHRINK_SHADOW_SPEC = Object.freeze({
  id: 'shrink_w15_l15',
  experimentId: 'cal_high_ev_tail',
  role: 'switchable_overlay_applied',
  openedAt: '2026-08-03',
  appliedAt: '2026-08-03',
  parentLockId: 'B-baseline-2026-07-30',
  highEvThreshold: 0.08,
  shrinkW: 0.15,
  /** 排序用：sortEv = adjEv - λ * max(0, rawEv − highEvThreshold) */
  rankLambda: 0.15,
  selection: Object.freeze({
    profile: 'ev02_max230',
    minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
    dropThirdIfMarginBelow: MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow,
    dropSecondIfOddsBelow: MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow,
    dropSecondIfOddsMin: MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin,
  }),
  observation: Object.freeze({
    minOverlayBets: 40,
    minOverlayDays: 15,
    earlyStopNetUsd50: -150,
    /** 單年窗相對基線容差（與 expanding WF 閘一致） */
    yearDeltaFloorUsd50: -50,
    stakeUsd: 50,
    mainKpis: Object.freeze([
      'delta_usd50_vs_formal',
      'rolling_2026',
      'high_ev_subset_still_improves',
    ]),
    promoteNote:
      '觀察達標且 2026 不再系統性拖後腿 → 再議可開關正式 overlay；預設仍不改 ev02 常數',
  }),
  wfEvidence: Object.freeze({
    expandingWfPass: true,
    recommend: 'shrink_w15_l15',
    artifact: 'tmp-cal-high-ev-tail-expanding-wf.json',
    note: '固定政策與 expanding 選參皆指向本變體；2026 窗略負須觀察期盯緊',
  }),
  note:
    '影子觀察中：不寫入 Locked B 主常數；HR 只監控；HR↑且 Δ$≤0 仍判失敗',
});

export function resolveHighEvShrinkShadowMode(raw = config.mlbHighEvShrinkShadowMode) {
  const v = String(raw || 'compare').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'compare' || v === 'shadow') return 'compare';
  return 'apply';
}

export function isHighEvShrinkShadowEnabled(mode = resolveHighEvShrinkShadowMode()) {
  return mode === 'compare' || mode === 'apply';
}

/**
 * 對單場 moneylineClassification 套用高 EV 收縮；不過原閘則降出 recommendation。
 * raw* 保留正式（Locked B）數值以便對照。
 */
export function applyHighEvShrinkToClassification(classification, rules = null) {
  if (!classification || classification.tier === 'blocked') {
    return { classification, touched: false, droppedByRegate: false };
  }
  const spec = MLB_HIGH_EV_SHRINK_SHADOW_SPEC;
  const profile = {
    ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
    ...(rules || {}),
    minimumH2hBookmakers: spec.selection.minimumH2hBookmakers,
  };
  const rawEv = Number(classification.expectedValue);
  const rawProb = Number(classification.modelProbability);
  const odds = Number(classification.odds);
  const margin = Number(classification.expectedRunMargin);
  const marketProb = Number(classification.marketProbability);
  if (!Number.isFinite(rawEv) || !Number.isFinite(rawProb) || !Number.isFinite(odds)) {
    return { classification, touched: false, droppedByRegate: false };
  }
  if (rawEv < spec.highEvThreshold) {
    return {
      classification: {
        ...classification,
        rawExpectedValue: rawEv,
        rawModelProbability: rawProb,
        highEvShrinkApplied: false,
        highEvShrinkSortEv: rawEv,
      },
      touched: false,
      droppedByRegate: false,
    };
  }

  const market = Number.isFinite(marketProb) && marketProb > 0 ? marketProb : 1 / odds;
  const adjProb = rawProb * (1 - spec.shrinkW) + market * spec.shrinkW;
  const adjEv = adjProb * (odds - 1) - (1 - adjProb);
  const sortEv = adjEv - spec.rankLambda * Math.max(0, rawEv - spec.highEvThreshold);

  const reasons = [...(classification.reasons || [])];
  let tier = classification.tier;
  let droppedByRegate = false;
  if (adjEv < profile.minimumExpectedValue) {
    reasons.push('high_ev_shrink_regate_ev');
    droppedByRegate = true;
  }
  if (adjProb < profile.minimumModelProbability) {
    reasons.push('high_ev_shrink_regate_prob');
    droppedByRegate = true;
  }
  if (Number.isFinite(margin) && margin < profile.minimumExpectedRunMargin) {
    reasons.push('high_ev_shrink_regate_margin');
    droppedByRegate = true;
  }
  if (odds < profile.minimumPickOdds || odds > profile.maximumPickOdds) {
    reasons.push('high_ev_shrink_regate_odds');
    droppedByRegate = true;
  }
  if (droppedByRegate && tier === 'recommendation') {
    tier = 'value_watch';
  }

  return {
    classification: {
      ...classification,
      tier,
      reasons,
      modelProbability: adjProb,
      expectedValue: adjEv,
      edge: adjProb - market,
      rawExpectedValue: rawEv,
      rawModelProbability: rawProb,
      highEvShrinkApplied: true,
      highEvShrinkSortEv: sortEv,
      highEvShrinkW: spec.shrinkW,
      highEvShrinkLambda: spec.rankLambda,
    },
    touched: true,
    droppedByRegate,
  };
}

function cloneGamesWithOverlay(gameRows) {
  return (gameRows || []).map((row) => {
    const cls = row.expectedRuns?.moneylineClassification;
    if (!cls) return { ...row };
    const { classification } = applyHighEvShrinkToClassification(cls);
    // 排序分數改用 sortEv（僅影子 rank 路徑）
    const forRank = {
      ...classification,
      expectedValue:
        classification.highEvShrinkSortEv != null
          ? classification.highEvShrinkSortEv
          : classification.expectedValue,
    };
    return {
      ...row,
      expectedRuns: {
        ...row.expectedRuns,
        moneylineClassification: forRank,
        moneylineClassificationDisplay: classification,
      },
    };
  });
}

function summarizeTopIds(ranked) {
  return (ranked || [])
    .filter(
      (g) =>
        g.researchTier === 'top1_observation' || g.researchTier === 'top3_observation'
    )
    .map((g) => ({
      gameId: g.gameId,
      day: g.researchDay,
      rank: g.dailyRank,
      tier: g.researchTier,
      pick:
        g.expectedRuns?.moneylineClassificationDisplay?.side === 'home' ||
        g.expectedRuns?.moneylineClassification?.side === 'home'
          ? g.homeTeam
          : g.awayTeam,
      ev:
        g.expectedRuns?.moneylineClassificationDisplay?.expectedValue ??
        g.expectedRuns?.moneylineClassification?.expectedValue ??
        null,
      rawEv:
        g.expectedRuns?.moneylineClassificationDisplay?.rawExpectedValue ??
        g.expectedRuns?.moneylineClassification?.rawExpectedValue ??
        null,
      touched: Boolean(
        g.expectedRuns?.moneylineClassificationDisplay?.highEvShrinkApplied ||
          g.expectedRuns?.moneylineClassification?.highEvShrinkApplied
      ),
    }));
}

/**
 * @param {object[]} formalRanked attachDailyResearchRanks 正式結果
 * @param {object[]} mappedGames 未 rank 的 mapped 列（含 classification）
 */
export function buildHighEvShrinkShadowSlate(mappedGames, formalRanked) {
  const mode = resolveHighEvShrinkShadowMode();
  const spec = MLB_HIGH_EV_SHRINK_SHADOW_SPEC;
  if (mode === 'off') {
    return {
      mode,
      enabled: false,
      spec,
      ranked: formalRanked,
      formalTop: summarizeTopIds(formalRanked),
      shadowTop: null,
      diff: null,
      observation: buildObservationStatus({ live: null }),
    };
  }

  const rules = {
    ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
    dropThirdIfMarginBelow: spec.selection.dropThirdIfMarginBelow,
    dropSecondIfOddsBelow: spec.selection.dropSecondIfOddsBelow,
    dropSecondIfOddsMin: spec.selection.dropSecondIfOddsMin,
  };
  const shadowMapped = cloneGamesWithOverlay(mappedGames);
  const shadowRankedRaw = attachDailyResearchRanks(shadowMapped, rules);
  const shadowRanked = shadowRankedRaw.map((row) => {
    const display = row.expectedRuns?.moneylineClassificationDisplay;
    if (!display) return row;
    return {
      ...row,
      expectedRuns: {
        ...row.expectedRuns,
        moneylineClassification: display,
      },
      research: row.research
        ? {
            ...row.research,
            ev: display.expectedValue,
            modelProb: display.modelProbability,
            edge: display.edge,
            rejectionReasons: display.reasons || row.research.rejectionReasons,
          }
        : row.research,
    };
  });
  const formalTop = summarizeTopIds(formalRanked);
  const shadowTop = summarizeTopIds(shadowRanked);
  const formalIds = new Set(formalTop.map((x) => x.gameId));
  const shadowIds = new Set(shadowTop.map((x) => x.gameId));
  const added = shadowTop.filter((x) => !formalIds.has(x.gameId));
  const dropped = formalTop.filter((x) => !shadowIds.has(x.gameId));
  const touchedInShadow = shadowTop.filter((x) => x.touched);

  return {
    mode,
    enabled: true,
    appliesToVisiblePicks: mode === 'apply',
    spec,
    ranked: mode === 'apply' ? shadowRanked : formalRanked,
    formalRanked,
    shadowRanked,
    formalTop,
    shadowTop,
    diff: {
      sameSlots: added.length === 0 && dropped.length === 0,
      added,
      dropped,
      touchedInShadowSlots: touchedInShadow.length,
      overlayTouchedCandidates: shadowMapped.filter(
        (g) => g.expectedRuns?.moneylineClassification?.highEvShrinkApplied
      ).length,
    },
    observation: buildObservationStatus({ live: loadLiveObserveSnapshot() }),
  };
}

function loadWfSnapshot() {
  try {
    if (!fs.existsSync(WF_SNAPSHOT)) return null;
    return JSON.parse(fs.readFileSync(WF_SNAPSHOT, 'utf8'));
  } catch {
    return null;
  }
}

function loadLiveObserveSnapshot() {
  try {
    if (!fs.existsSync(LIVE_SNAPSHOT)) return null;
    return JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, 'utf8'));
  } catch {
    return null;
  }
}

export function writeHighEvShrinkLiveObserveSnapshot(payload) {
  const body = {
    generatedAt: new Date().toISOString(),
    overlayId: MLB_HIGH_EV_SHRINK_SHADOW_SPEC.id,
    ...payload,
  };
  fs.writeFileSync(LIVE_SNAPSHOT, JSON.stringify(body, null, 2));
  return body;
}

export function buildObservationStatus({ live = null } = {}) {
  const obs = MLB_HIGH_EV_SHRINK_SHADOW_SPEC.observation;
  const wf = loadWfSnapshot();
  const isHistReplay = live?.source === 'historical_replay_frozen_b_picks';
  const liveBets = isHistReplay ? 0 : Number(live?.overlayBets ?? live?.bets ?? 0);
  const liveDays = isHistReplay ? 0 : Number(live?.overlayDays ?? live?.days ?? 0);
  const liveDelta = isHistReplay ? null : live?.deltaUsd50 ?? null;
  const live2026 = isHistReplay ? null : live?.byYear?.['2026']?.deltaUsd50 ?? null;
  const sampleReady =
    liveBets >= obs.minOverlayBets || liveDays >= obs.minOverlayDays;
  const earlyStop =
    liveDelta != null && Number(liveDelta) <= obs.earlyStopNetUsd50;
  const year2026Hurt =
    live2026 != null && Number(live2026) < obs.yearDeltaFloorUsd50;
  let status = 'observing';
  if (earlyStop) status = 'early_stop_fail';
  else if (sampleReady && year2026Hurt) status = 'hold_2026_drag';
  else if (sampleReady && liveDelta != null && Number(liveDelta) > 0 && !year2026Hurt) {
    status = 'ready_to_discuss_apply_formal_toggle';
  }

  return {
    status,
    sampleReady,
    earlyStop,
    year2026Hurt,
    gates: obs,
    historicalReplay: isHistReplay
      ? {
          overlayBets: Number(live?.overlayBets ?? 0),
          overlayDays: Number(live?.overlayDays ?? 0),
          deltaUsd50: live?.deltaUsd50 ?? null,
          byYear: live?.byYear ?? null,
          highEvSubsetDeltaUsd50: live?.highEvSubsetDeltaUsd50 ?? null,
          note: '歷史重放僅作基線參考，不計入活體觀察樣本／升格討論',
        }
      : null,
    live: isHistReplay
      ? {
          overlayBets: 0,
          overlayDays: 0,
          deltaUsd50: null,
          note: '觀察期以活體 compare/apply 累積為準；歷史重放見 historicalReplay',
        }
      : live
        ? {
            overlayBets: liveBets,
            overlayDays: liveDays,
            deltaUsd50: liveDelta,
            byYear: live.byYear ?? null,
            highEvSubsetDeltaUsd50: live.highEvSubsetDeltaUsd50 ?? null,
          }
        : {
            overlayBets: 0,
            overlayDays: 0,
            deltaUsd50: null,
            note: '活體影子對照尚未寫入 observe 快照；WF 證據見 wfEvidence',
          },
    wfEvidence: {
      available: Boolean(wf),
      verdict: wf?.verdict ?? MLB_HIGH_EV_SHRINK_SHADOW_SPEC.wfEvidence.note,
      fixedW15L15Pass: wf?.gates?.fixedW15L15Pass ?? null,
      expandingDeltaW15L15: wf?.expanding?.deltaW15L15 ?? null,
      byYear2026:
        wf?.fixedMonthlyOos?.shrink_w15_l15?.byYear?.['2026'] ?? null,
    },
    rules: [
      `模式 off|compare|apply（現用環境 MLB_HIGH_EV_SHRINK_SHADOW）`,
      `僅 EV≥${MLB_HIGH_EV_SHRINK_SHADOW_SPEC.highEvThreshold} 子集收縮 w=${MLB_HIGH_EV_SHRINK_SHADOW_SPEC.shrinkW}，再過原閘後進日 Top`,
      `最低樣本：≥${obs.minOverlayBets} 筆套用 overlay 的注，或 ≥${obs.minOverlayDays} 個有該類選邊日（活體）`,
      `提前停：觀察期淨 Δ@$50 ≤ ${obs.earlyStopNetUsd50}，或 2026 滾動惡化超容差`,
      obs.promoteNote,
      '勝率只監控；HR↑ 且 Δ$≤0 仍判失敗',
      'CLV 台帳另軌；撤單規則滿 40 完整筆再評',
      'v4.6 繼續暫緩',
    ],
  };
}

export function getHighEvShrinkShadowObservationSummary() {
  const mode = resolveHighEvShrinkShadowMode();
  return {
    available: true,
    mode,
    enabled: isHighEvShrinkShadowEnabled(mode),
    appliesToVisiblePicks: mode === 'apply',
    spec: MLB_HIGH_EV_SHRINK_SHADOW_SPEC,
    observation: buildObservationStatus({ live: loadLiveObserveSnapshot() }),
    note:
      mode === 'off'
        ? '影子 overlay 關閉'
        : mode === 'apply'
          ? '已套用至可看選邊／紙上晉升（非升格常數；設 MLB_HIGH_EV_SHRINK_SHADOW=compare|off 可退）'
          : '對照中：正式選邊不變，slate 附 shadowTop 差異',
  };
}

/** 供 rank 分數對照：影子排序 EV */
export function scoreHighEvShrinkDailyRank(classification, rules) {
  const { classification: adj } = applyHighEvShrinkToClassification(classification, rules);
  return scoreMlbMoneylineDailyRank(
    {
      expectedValue: adj.highEvShrinkSortEv ?? adj.expectedValue,
      modelProbability: adj.modelProbability,
      pickEarlyExitsHigher: adj.pickEarlyExitsHigher,
    },
    rules || MLB_MONEYLINE_RULE_PROFILES.ev02_max230
  );
}
