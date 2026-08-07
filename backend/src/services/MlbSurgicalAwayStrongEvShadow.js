/**
 * 影子觀察：手術 A — 高 EV≥10% × 選客 × 主勝率≥65% → 不下
 *
 * 狀態：可開關 overlay（不改 Locked B / ev02 主常數）
 * - off：關閉
 * - compare：正式選邊不變，slate 標註 wouldSkip
 * - apply：從可看選邊／紙上晉升剔除（預設；仍可一鍵關）
 *
 * 環境變數：MLB_SURGICAL_AWAY_STRONG_EV_SHADOW=off|compare|apply（預設 off）
 *
 * 與既有「毒客 shrink」差異：shrink 只壓 P；本刀對仍過閘的高 EV 客打強主 → 直接跳過。
 * 與 toxicAwayRank1Ev10 差異：本刀不限 Rank1。
 * 合併政策：正式提勝率改用 MlbWinrateStrongHomeShadow（hwp≥62%）；本刀預設 off 防雙砍。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_SNAPSHOT = path.join(
  __dirname,
  '../../tmp-surgical-away-strong-ev-observe.json'
);

/** @type {const} */
export const MLB_SURGICAL_AWAY_STRONG_EV_SPEC = Object.freeze({
  id: 'surgical_a_away_strong_ev10',
  experimentId: 'surgical-away-strong-ev-2026-08-06',
  role: 'switchable_overlay_applied',
  openedAt: '2026-08-06',
  appliedAt: '2026-08-06',
  parentLockId: 'B-baseline-2026-07-30',
  rule: Object.freeze({
    minEv: 0.1,
    pickAway: true,
    strongHomeWinPct: 0.65,
  }),
  paperEvidenceUsd50: Object.freeze({
    baseline: Object.freeze({
      bets: 697,
      hitRate: 0.5495,
      roi: 0.1412,
      usd50: 4922,
    }),
    afterCut: Object.freeze({
      bets: 656,
      hitRate: 0.5549,
      roi: 0.1479,
      usd50: 4852,
    }),
    cutSubset: Object.freeze({
      bets: 41,
      hitRate: 0.4634,
      roi: 0.0341,
      usd50: 70,
      cutPct: 5.9,
    }),
    note: 'Frozen B 影子重放 @$50；Δ$≈−70，HR/ROI 略升',
  }),
  observation: Object.freeze({
    minFlaggedBets: 25,
    minFlaggedDays: 12,
    earlyStopNetUsd50: -120,
    yearDeltaFloorUsd50: -80,
    stakeUsd: 50,
    mainKpis: Object.freeze([
      'delta_usd50_vs_formal',
      'rolling_2026',
      'cut_subset_still_weak',
    ]),
    promoteNote:
      '活體樣本達標且 Δ$ 非系統性惡化、2026 不拖後腿 → 再議是否 apply／升格硬跳過',
  }),
  note:
    '已套用可看選邊（非升格常數）；回退 MLB_SURGICAL_AWAY_STRONG_EV_SHADOW=compare|off；只動獨贏',
});

export function resolveSurgicalAwayStrongEvMode(
  raw = config.mlbSurgicalAwayStrongEvShadowMode
) {
  const v = String(raw || 'off').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'compare' || v === 'shadow') return 'compare';
  return 'apply';
}

export function isSurgicalAwayStrongEvEnabled(
  mode = resolveSurgicalAwayStrongEvMode()
) {
  return mode === 'compare' || mode === 'apply';
}

/**
 * @param {{ side?: string, expectedValue?: number, homeWinPct?: number|null }} classification
 * @param {{ homeWinPct?: number|null }} [extra]
 */
export function matchesSurgicalAwayStrongEv(classification, extra = {}) {
  if (!classification || classification.tier === 'blocked') return false;
  const rule = MLB_SURGICAL_AWAY_STRONG_EV_SPEC.rule;
  const side = classification.side;
  const ev = Number(classification.expectedValue);
  const homeWinPct = Number(
    classification.homeWinPct ?? extra.homeWinPct ?? NaN
  );
  if (side !== 'away') return false;
  if (!Number.isFinite(ev) || ev < rule.minEv) return false;
  if (!Number.isFinite(homeWinPct) || homeWinPct < rule.strongHomeWinPct) {
    return false;
  }
  return true;
}

function isPaperTier(tier) {
  return (
    tier === 'top1_observation' ||
    tier === 'top3_observation' ||
    tier === 'strict_observation'
  );
}

function summarizeTopIds(ranked) {
  return (ranked || [])
    .filter((g) => isPaperTier(g.researchTier))
    .sort(
      (a, b) =>
        String(a.researchDay).localeCompare(String(b.researchDay)) ||
        (a.dailyRank || 99) - (b.dailyRank || 99)
    )
    .map((g) => {
      const pick = g.expectedRuns?.moneylineClassification;
      return {
        gameId: g.gameId,
        researchDay: g.researchDay,
        dailyRank: g.dailyRank,
        researchTier: g.researchTier,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`,
        side: pick?.side ?? null,
        expectedValue: pick?.expectedValue ?? null,
        homeWinPct: pick?.homeWinPct ?? null,
        surgicalFlag: Boolean(pick?.surgicalAwayStrongEvWouldSkip),
      };
    });
}

/**
 * 在日內排名結果上標註／可選剔除手術 A 病灶。
 * @param {object[]} rankedGames attachDailyResearchRanks 結果（可已套 high-EV shrink）
 */
export function buildSurgicalAwayStrongEvShadowSlate(rankedGames) {
  const mode = resolveSurgicalAwayStrongEvMode();
  const spec = MLB_SURGICAL_AWAY_STRONG_EV_SPEC;
  if (mode === 'off') {
    return {
      mode,
      enabled: false,
      appliesToVisiblePicks: false,
      spec,
      ranked: rankedGames,
      formalTop: summarizeTopIds(rankedGames),
      shadowTop: null,
      flagged: [],
      diff: null,
      observation: buildSurgicalObservationStatus({ live: null }),
    };
  }

  const formalTop = summarizeTopIds(rankedGames);
  const flagged = [];
  const annotated = (rankedGames || []).map((g) => {
    const cls = g.expectedRuns?.moneylineClassification;
    const hit = matchesSurgicalAwayStrongEv(cls);
    if (hit && isPaperTier(g.researchTier)) {
      flagged.push({
        gameId: g.gameId,
        researchDay: g.researchDay,
        dailyRank: g.dailyRank,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`,
        expectedValue: cls?.expectedValue ?? null,
        homeWinPct: cls?.homeWinPct ?? null,
        odds: cls?.odds ?? null,
      });
    }
    if (!cls) return g;
    const nextCls = {
      ...cls,
      surgicalAwayStrongEvWouldSkip: hit,
      surgicalAwayStrongEvSpecId: hit ? spec.id : undefined,
    };
    if (mode === 'apply' && hit && cls.tier === 'recommendation') {
      nextCls.tier = 'value_watch';
      nextCls.reasons = [
        ...(cls.reasons || []),
        'surgical_away_strong_ev_skip',
      ];
    }
    return {
      ...g,
      expectedRuns: {
        ...g.expectedRuns,
        moneylineClassification: nextCls,
      },
      researchTier:
        mode === 'apply' && hit && isPaperTier(g.researchTier)
          ? 'value_watch'
          : g.researchTier,
      research: g.research
        ? {
            ...g.research,
            rejectionReasons: hit
              ? [
                  ...(g.research.rejectionReasons || []),
                  ...(mode === 'apply' ? ['surgical_away_strong_ev_skip'] : []),
                ]
              : g.research.rejectionReasons,
          }
        : g.research,
    };
  });

  const shadowTop = summarizeTopIds(annotated);
  const formalIds = new Set(formalTop.map((x) => x.gameId));
  const shadowIds = new Set(shadowTop.map((x) => x.gameId));

  return {
    mode,
    enabled: true,
    appliesToVisiblePicks: mode === 'apply',
    spec,
    ranked: mode === 'apply' ? annotated : rankedGames.map((g, i) => {
      // compare：保留正式 tier，但附註記到 classification
      const ann = annotated[i];
      const cls = ann?.expectedRuns?.moneylineClassification;
      if (!cls?.surgicalAwayStrongEvWouldSkip) return g;
      return {
        ...g,
        expectedRuns: {
          ...g.expectedRuns,
          moneylineClassification: {
            ...g.expectedRuns?.moneylineClassification,
            surgicalAwayStrongEvWouldSkip: true,
            surgicalAwayStrongEvSpecId: spec.id,
          },
        },
      };
    }),
    formalRanked: rankedGames,
    shadowRanked: annotated,
    formalTop,
    shadowTop,
    flagged,
    diff: {
      sameSlots: formalIds.size === shadowIds.size &&
        [...formalIds].every((id) => shadowIds.has(id)),
      wouldSkipFromFormalTop: formalTop.filter((x) => !shadowIds.has(x.gameId)),
      flaggedInFormalTop: flagged.length,
    },
    observation: buildSurgicalObservationStatus({ live: loadLiveObserveSnapshot() }),
  };
}

function loadLiveObserveSnapshot() {
  try {
    if (!fs.existsSync(LIVE_SNAPSHOT)) return null;
    return JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSurgicalAwayStrongEvObserveSnapshot(payload) {
  const body = {
    generatedAt: new Date().toISOString(),
    overlayId: MLB_SURGICAL_AWAY_STRONG_EV_SPEC.id,
    ...payload,
  };
  fs.writeFileSync(LIVE_SNAPSHOT, JSON.stringify(body, null, 2));
  return body;
}

export function buildSurgicalObservationStatus({ live = null } = {}) {
  const obs = MLB_SURGICAL_AWAY_STRONG_EV_SPEC.observation;
  const isHistReplay = live?.source === 'historical_replay_frozen_b_picks';
  const liveBets = isHistReplay ? 0 : Number(live?.flaggedBets ?? live?.cutN ?? 0);
  const liveDays = isHistReplay ? 0 : Number(live?.flaggedDays ?? 0);
  const liveDelta = isHistReplay ? null : live?.deltaUsd50 ?? null;
  const live2026 = isHistReplay ? null : live?.byYear?.['2026']?.deltaUsd50 ?? null;
  const sampleReady =
    liveBets >= obs.minFlaggedBets || liveDays >= obs.minFlaggedDays;
  const earlyStop =
    liveDelta != null && Number(liveDelta) <= obs.earlyStopNetUsd50;
  const year2026Hurt =
    live2026 != null && Number(live2026) < obs.yearDeltaFloorUsd50;
  let status = 'observing';
  if (earlyStop) status = 'early_stop_fail';
  else if (sampleReady && year2026Hurt) status = 'hold_2026_drag';
  else if (
    sampleReady &&
    liveDelta != null &&
    Number(liveDelta) >= -40 &&
    !year2026Hurt
  ) {
    status = 'ready_to_discuss_apply';
  }

  return {
    status,
    sampleReady,
    earlyStop,
    year2026Hurt,
    gates: obs,
    historicalReplay: isHistReplay
      ? {
          flaggedBets: Number(live?.flaggedBets ?? live?.cutN ?? 0),
          deltaUsd50: live?.deltaUsd50 ?? null,
          byYear: live?.byYear ?? null,
          kept: live?.kept ?? null,
          cut: live?.cut ?? null,
          note: '歷史重放僅作基線參考，不計入活體觀察樣本',
        }
      : null,
    live: isHistReplay
      ? {
          flaggedBets: 0,
          flaggedDays: 0,
          deltaUsd50: null,
          note: '觀察期以活體 compare/apply 累積為準',
        }
      : live
        ? {
            flaggedBets: liveBets,
            flaggedDays: liveDays,
            deltaUsd50: liveDelta,
            byYear: live.byYear ?? null,
          }
        : {
            flaggedBets: 0,
            flaggedDays: 0,
            deltaUsd50: null,
            note: '活體尚未寫入 observe 快照；先跑 report 腳本建歷史基線',
          },
    paperEvidence: MLB_SURGICAL_AWAY_STRONG_EV_SPEC.paperEvidenceUsd50,
    rules: [
      `模式 off|compare|apply（環境 MLB_SURGICAL_AWAY_STRONG_EV_SHADOW，預設 apply）`,
      `規則：EV≥${MLB_SURGICAL_AWAY_STRONG_EV_SPEC.rule.minEv} 且選客 且 homeWinPct≥${MLB_SURGICAL_AWAY_STRONG_EV_SPEC.rule.strongHomeWinPct} → 影子跳過`,
      `最低活體樣本：≥${obs.minFlaggedBets} 筆被標註，或 ≥${obs.minFlaggedDays} 個有標註日`,
      `提前停：活體淨 Δ@$50 ≤ ${obs.earlyStopNetUsd50}`,
      obs.promoteNote,
      '不改 Locked B 主常數；與高 EV shrink 疊加時先 shrink 再判本刀',
    ],
  };
}

export function getSurgicalAwayStrongEvObservationSummary() {
  const mode = resolveSurgicalAwayStrongEvMode();
  return {
    available: true,
    mode,
    enabled: isSurgicalAwayStrongEvEnabled(mode),
    appliesToVisiblePicks: mode === 'apply',
    spec: MLB_SURGICAL_AWAY_STRONG_EV_SPEC,
    observation: buildSurgicalObservationStatus({
      live: loadLiveObserveSnapshot(),
    }),
    note:
      mode === 'off'
        ? '手術 A overlay 關閉'
        : mode === 'apply'
          ? '已套用至可看選邊／紙上晉升（非升格常數；設 compare|off 可退）'
          : '對照中：正式選邊不變，slate 標註 wouldSkip',
  };
}
