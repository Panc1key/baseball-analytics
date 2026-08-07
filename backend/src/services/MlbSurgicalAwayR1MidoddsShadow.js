/**
 * 正式 overlay：客 × Rank1 × 中水賠率 1.95–2.10 → 不下
 *
 * 狀態：正式套用（不改 Locked B / ev02 主常數）
 * - off：關閉
 * - compare：正式選邊不變，slate 標註 wouldSkip
 * - apply：從可看選邊／紙上晉升剔除（預設＝正式）
 *
 * 環境變數：MLB_SURGICAL_AWAY_R1_MIDODDS_SHADOW=off|compare|apply（預設 apply）
 *
 * 正式升格依據（Frozen B @$50，2024–2026）：
 * - 切片 n=118 HR47.5% ROI−4.5% −$264
 * - 砍後 n=579 HR56.5% ROI17.9% +$5186（Δ+$264）；三年皆正
 * - 對照：同賠率客 R2、主 R1、客 R1 長水≥2.10 皆正常 → 病灶在「客+日冠+中水」交叉
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_SNAPSHOT = path.join(
  __dirname,
  '../../tmp-surgical-away-r1-midodds-observe.json'
);

/** @type {const} */
export const MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC = Object.freeze({
  id: 'surgical_b_away_r1_midodds',
  experimentId: 'surgical-away-r1-midodds-2026-08-06',
  role: 'formal_overlay_applied',
  openedAt: '2026-08-06',
  appliedAt: '2026-08-08',
  formalAt: '2026-08-08',
  parentLockId: 'B-baseline-2026-07-30',
  rule: Object.freeze({
    pickAway: true,
    rank: 1,
    minOdds: 1.95,
    maxOddsExclusive: 2.1,
  }),
  diagnosis: Object.freeze({
    plain:
      '日內第一推薦的客隊、賠率卡在約兩倍附近：模型說五成五，實際只有四成七；打平要約五成，差兩個百分點就整片虧錢。同賠率的客隊第二推薦反而很賺 → 比較像「排第一時過度自信」，不是中水本身有毒。',
    weakSubSlices: Object.freeze([
      '切片內 EV 5–15%（≥15% 尚可）',
      '切片內 P<56%',
      '切片內 margin 0.4–0.7',
      '切片內賠率 2.00–2.05 最毒',
    ]),
    healthyControls: Object.freeze([
      '客 R2 × 同中水：HR≈63% ROI≈26%',
      '主 R1 × 同中水：HR≈56% ROI≈13%',
      '客 R1 × 賠率≥2.10：HR≈55% ROI≈25%',
    ]),
  }),
  paperEvidenceUsd50: Object.freeze({
    baseline: Object.freeze({
      bets: 697,
      hitRate: 0.5495,
      roi: 0.1412,
      usd50: 4922,
    }),
    afterCut: Object.freeze({
      bets: 579,
      hitRate: 0.5648,
      roi: 0.1791,
      usd50: 5186,
    }),
    cutSubset: Object.freeze({
      bets: 118,
      hitRate: 0.4746,
      roi: -0.0447,
      usd50: -264,
      cutPct: 16.9,
    }),
    byYearDeltaUsd50: Object.freeze({
      '2024': 127,
      '2025': 46,
      '2026': 91,
    }),
    note: 'Frozen B 影子重放 @$50；三年皆正 Δ；總 Δ$≈+264',
  }),
  observation: Object.freeze({
    minFlaggedBets: 30,
    minFlaggedDays: 15,
    earlyStopNetUsd50: -150,
    yearDeltaFloorUsd50: -80,
    stakeUsd: 50,
    mainKpis: Object.freeze([
      'delta_usd50_vs_formal',
      'rolling_2026',
      'cut_subset_still_weak',
      'control_r2_same_odds_still_healthy',
    ]),
    promoteNote:
      '活體達標且三年滾動不翻車 → 再議 apply；可先試更窄子刀（如僅 2.00–2.05 或 P<56）',
  }),
  note:
    '正式套用可看選邊／紙上（非升格常數）；回退 MLB_SURGICAL_AWAY_R1_MIDODDS_SHADOW=compare|off；只動獨贏',
});

export function resolveSurgicalAwayR1MidoddsMode(
  raw = config.mlbSurgicalAwayR1MidoddsShadowMode
) {
  const v = String(raw || 'apply').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'compare' || v === 'shadow') return 'compare';
  return 'apply';
}

export function isSurgicalAwayR1MidoddsEnabled(
  mode = resolveSurgicalAwayR1MidoddsMode()
) {
  return mode === 'compare' || mode === 'apply';
}

/**
 * @param {{ side?: string, odds?: number, homeWinPct?: number|null }} classification
 * @param {{ dailyRank?: number, rank?: number }} [extra]
 */
export function matchesSurgicalAwayR1Midodds(classification, extra = {}) {
  if (!classification || classification.tier === 'blocked') return false;
  const rule = MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.rule;
  const side = classification.side;
  const odds = Number(classification.odds);
  const rank = Number(extra.dailyRank ?? extra.rank ?? NaN);
  if (side !== 'away') return false;
  if (rank !== rule.rank) return false;
  if (!Number.isFinite(odds)) return false;
  if (odds < rule.minOdds || odds >= rule.maxOddsExclusive) return false;
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
        odds: pick?.odds ?? null,
        surgicalFlag: Boolean(pick?.surgicalAwayR1MidoddsWouldSkip),
      };
    });
}

/**
 * @param {object[]} rankedGames 已含 dailyRank 的日內排名結果
 */
export function buildSurgicalAwayR1MidoddsShadowSlate(rankedGames) {
  const mode = resolveSurgicalAwayR1MidoddsMode();
  const spec = MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC;
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
      observation: buildSurgicalAwayR1MidoddsObservationStatus({ live: null }),
    };
  }

  const formalTop = summarizeTopIds(rankedGames);
  const flagged = [];
  const annotated = (rankedGames || []).map((g) => {
    const cls = g.expectedRuns?.moneylineClassification;
    const hit = matchesSurgicalAwayR1Midodds(cls, {
      dailyRank: g.dailyRank,
      rank: g.dailyRank,
    });
    if (hit && isPaperTier(g.researchTier)) {
      flagged.push({
        gameId: g.gameId,
        researchDay: g.researchDay,
        dailyRank: g.dailyRank,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`,
        odds: cls?.odds ?? null,
        expectedValue: cls?.expectedValue ?? null,
        modelProb: cls?.modelProbability ?? null,
      });
    }
    if (!cls) return g;
    const nextCls = {
      ...cls,
      surgicalAwayR1MidoddsWouldSkip: hit,
      surgicalAwayR1MidoddsSpecId: hit ? spec.id : undefined,
    };
    if (mode === 'apply' && hit && cls.tier === 'recommendation') {
      nextCls.tier = 'value_watch';
      nextCls.reasons = [
        ...(cls.reasons || []),
        'surgical_away_r1_midodds_skip',
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
                  ...(mode === 'apply'
                    ? ['surgical_away_r1_midodds_skip']
                    : []),
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
    ranked:
      mode === 'apply'
        ? annotated
        : rankedGames.map((g, i) => {
            const ann = annotated[i];
            const cls = ann?.expectedRuns?.moneylineClassification;
            if (!cls?.surgicalAwayR1MidoddsWouldSkip) return g;
            return {
              ...g,
              expectedRuns: {
                ...g.expectedRuns,
                moneylineClassification: {
                  ...g.expectedRuns?.moneylineClassification,
                  surgicalAwayR1MidoddsWouldSkip: true,
                  surgicalAwayR1MidoddsSpecId: spec.id,
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
      sameSlots:
        formalIds.size === shadowIds.size &&
        [...formalIds].every((id) => shadowIds.has(id)),
      wouldSkipFromFormalTop: formalTop.filter((x) => !shadowIds.has(x.gameId)),
      flaggedInFormalTop: flagged.length,
    },
    observation: buildSurgicalAwayR1MidoddsObservationStatus({
      live: loadLiveObserveSnapshot(),
    }),
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

export function writeSurgicalAwayR1MidoddsObserveSnapshot(payload) {
  const body = {
    generatedAt: new Date().toISOString(),
    overlayId: MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.id,
    ...payload,
  };
  fs.writeFileSync(LIVE_SNAPSHOT, JSON.stringify(body, null, 2));
  return body;
}

export function buildSurgicalAwayR1MidoddsObservationStatus({ live = null } = {}) {
  const obs = MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.observation;
  const isHistReplay = live?.source === 'historical_replay_frozen_b_picks';
  const liveBets = isHistReplay
    ? 0
    : Number(live?.flaggedBets ?? live?.cutN ?? 0);
  const liveDays = isHistReplay ? 0 : Number(live?.flaggedDays ?? 0);
  const liveDelta = isHistReplay ? null : live?.deltaUsd50 ?? null;
  const live2026 = isHistReplay
    ? null
    : live?.byYear?.['2026']?.deltaUsd50 ?? null;
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
    Number(liveDelta) >= 0 &&
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
    diagnosis: MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.diagnosis,
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
            note: '活體尚未寫入；先跑 report 腳本建歷史基線',
          },
    paperEvidence: MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.paperEvidenceUsd50,
    rules: [
      `模式 off|compare|apply（環境 MLB_SURGICAL_AWAY_R1_MIDODDS_SHADOW，預設 apply）`,
      `規則：選客 且 dailyRank=1 且賠率∈[${MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.rule.minOdds}, ${MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC.rule.maxOddsExclusive}) → 影子跳過`,
      `最低活體樣本：≥${obs.minFlaggedBets} 筆被標註，或 ≥${obs.minFlaggedDays} 個有標註日`,
      `提前停：活體淨 Δ@$50 ≤ ${obs.earlyStopNetUsd50}`,
      obs.promoteNote,
      '不改 Locked B 主常數；排在高 EV shrink / 手術 A 之後套用',
    ],
  };
}

export function getSurgicalAwayR1MidoddsObservationSummary() {
  const mode = resolveSurgicalAwayR1MidoddsMode();
  return {
    available: true,
    mode,
    enabled: isSurgicalAwayR1MidoddsEnabled(mode),
    appliesToVisiblePicks: mode === 'apply',
    spec: MLB_SURGICAL_AWAY_R1_MIDODDS_SPEC,
    observation: buildSurgicalAwayR1MidoddsObservationStatus({
      live: loadLiveObserveSnapshot(),
    }),
    note:
      mode === 'off'
        ? '手術 B（客R1中水）overlay 關閉'
        : mode === 'apply'
          ? '已套用至可看選邊／紙上晉升（非升格常數；設 compare|off 可退）'
          : '對照中：正式選邊不變，slate 標註 wouldSkip',
  };
}
