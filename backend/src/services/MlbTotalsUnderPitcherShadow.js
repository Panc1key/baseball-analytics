/**
 * 大小 Hybrid 可開關 overlay：Under × 投手公園 → 不下
 *
 * 狀態：已套用（不改 Hybrid v1.1 主常數）
 * - off：關閉
 * - compare：正式 Hybrid 選邊不變，標註 wouldSkip
 * - apply：從 Hybrid 可看選邊剔除（預設；仍可一鍵關）
 *
 * 環境變數：MLB_TOTALS_UNDER_PITCHER_SHADOW=off|compare|apply（預設 apply）
 *
 * 升格證據：auditMlbTotalsUnderPitcherPromoteGate.mjs（閘門全過）
 * 病灶：raw_under ∩ parkFactor&lt;0.97；紙上 n=51 HR45% ROI−13%；
 * 對照 Under×mid/hitter、Over·投手去偏、Over·raw 皆仍健康 → 交叉項而非整類幻覺
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { MLB_TOTALS_SATELLITE_HYBRID_SPEC } from './MlbTotalsSatellite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_SNAPSHOT = path.join(
  __dirname,
  '../../tmp-totals-under-pitcher-observe.json'
);

/** @type {const} */
export const MLB_TOTALS_UNDER_PITCHER_SPEC = Object.freeze({
  id: 'totals_cut_under_pitcher_park',
  experimentId: 'totals-under-pitcher-shadow-2026-08-06',
  role: 'switchable_overlay_applied',
  openedAt: '2026-08-06',
  appliedAt: '2026-08-07',
  parentHybridSpecId: MLB_TOTALS_SATELLITE_HYBRID_SPEC.id,
  promoteGate: Object.freeze({
    script: 'scripts/auditMlbTotalsUnderPitcherPromoteGate.mjs',
    artifact: 'tmp-totals-under-pitcher-promote-gate.json',
    pass: true,
    note:
      '交叉項驗證：Under×mid/hitter ROI18%、投手Over ROI12%、raw_over ROI14% 皆健康；被砍片 ROI−13%；月正占比 0.81→0.88',
  }),
  rule: Object.freeze({
    side: 'under',
    hybridPath: 'raw_under',
    pitcherParkFactorMax:
      Number(MLB_TOTALS_SATELLITE_HYBRID_SPEC.pitcherParkFactorMax) || 0.97,
  }),
  diagnosis: Object.freeze({
    plain:
      '投手公園本來就不容易打出分數，系統卻常推「小分」；實際勝率只有四成五、整片虧錢。中性／打者公園的小分、以及同公園的 Over 去偏仍正常 → 不是「大小全錯」或「投手公園全錯」。',
    sampleNote:
      '被砍 51 注主要落在 2025（33）與 2026（16）；2024 僅 2 注，單年 Δ 參考價值低，但未系統性傷兩年以上。',
    keep: Object.freeze([
      'Under × mid/hitter 公園',
      'Over·raw（v1.1 已限 absGap≤1.25）',
      'Over·投手去偏',
    ]),
  }),
  paperEvidenceUsd50: Object.freeze({
    baseline: Object.freeze({
      bets: 787,
      hitRate: 0.5832,
      roi: 0.1339,
      usd50: 5270,
    }),
    afterCut: Object.freeze({
      bets: 736,
      hitRate: 0.5924,
      roi: 0.1521,
      usd50: 5596,
    }),
    cutSubset: Object.freeze({
      bets: 51,
      hitRate: 0.451,
      roi: -0.1278,
      usd50: -326,
      cutPct: 6.5,
    }),
    byYearDeltaUsd50: Object.freeze({
      '2024': -83,
      '2025': 377,
      '2026': 33,
    }),
    note: 'Hybrid v1.1 影子重放 @$50；總 Δ$≈+326；promote gate 全過後 apply',
  }),
  observation: Object.freeze({
    minFlaggedBets: 20,
    minFlaggedDays: 12,
    earlyStopNetUsd50: -120,
    yearDeltaFloorUsd50: -100,
    stakeUsd: 50,
    mainKpis: Object.freeze([
      'delta_usd50_vs_formal',
      'rolling_2026',
      'cut_subset_still_weak',
    ]),
    promoteNote:
      '已 apply；若活體淨 Δ@$50 ≤ −120 或 2026 明顯拖後腿 → 設 compare|off 回退',
  }),
  note:
    '已套用可看 Hybrid 選邊（非改 v1.1 主常數）；回退 MLB_TOTALS_UNDER_PITCHER_SHADOW=compare|off；只動大小',
});

export function resolveTotalsUnderPitcherMode(
  raw = config.mlbTotalsUnderPitcherShadowMode
) {
  const v = String(raw || 'apply').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'compare' || v === 'shadow') return 'compare';
  return 'apply';
}

export function isTotalsUnderPitcherEnabled(
  mode = resolveTotalsUnderPitcherMode()
) {
  return mode === 'compare' || mode === 'apply';
}

/**
 * @param {{ side?: string, hybridPath?: string|null, parkFactor?: number|null, parkBucket?: string|null }} c
 */
export function matchesTotalsUnderPitcher(c) {
  if (!c || c.tier === 'blocked') return false;
  const rule = MLB_TOTALS_UNDER_PITCHER_SPEC.rule;
  if (c.side !== 'under') return false;
  if (c.hybridPath && c.hybridPath !== rule.hybridPath) return false;
  const pf = Number(c.parkFactor);
  if (Number.isFinite(pf)) {
    return pf < rule.pitcherParkFactorMax;
  }
  if (c.parkBucket === 'pitcher') return true;
  // 無公園資訊時不誤砍
  return false;
}

/**
 * 單場 Hybrid 分類後套用（接在 FragileUnder 之後）。
 */
export function applyTotalsUnderPitcherToCandidate(candidate) {
  if (!candidate) return candidate;
  const out = applyTotalsUnderPitcherShadow([candidate]);
  return out.annotated?.[0] || out.candidates?.[0] || candidate;
}

/**
 * 過濾／標註 Hybrid 候選。
 * @param {object[]} candidates
 */
export function applyTotalsUnderPitcherShadow(candidates = []) {
  const mode = resolveTotalsUnderPitcherMode();
  const spec = MLB_TOTALS_UNDER_PITCHER_SPEC;
  if (mode === 'off') {
    return {
      mode,
      enabled: false,
      appliesToVisiblePicks: false,
      spec,
      candidates,
      annotated: candidates,
      flagged: [],
      observation: buildTotalsUnderPitcherObservationStatus({ live: null }),
    };
  }

  const flagged = [];
  const annotated = (candidates || []).map((c) => {
    const hit = matchesTotalsUnderPitcher(c);
    if (hit) {
      flagged.push({
        gameId: c.gameId,
        matchup: c.matchup,
        commenceTime: c.commenceTime,
        side: c.side,
        line: c.line,
        hybridPath: c.hybridPath,
        parkFactor: c.parkFactor ?? null,
        expectedValue: c.expectedValue,
        absGap: c.absGap,
      });
    }
    return {
      ...c,
      totalsUnderPitcherWouldSkip: hit,
      totalsUnderPitcherSpecId: hit ? spec.id : undefined,
      reasons: hit
        ? [...(c.reasons || []), 'totals_under_pitcher_park_skip']
        : c.reasons,
      tier:
        mode === 'apply' && hit && c.tier === 'actionable'
          ? 'blocked'
          : c.tier,
    };
  });

  const forSelect =
    mode === 'apply'
      ? annotated.filter((c) => !c.totalsUnderPitcherWouldSkip)
      : annotated;

  return {
    mode,
    enabled: true,
    appliesToVisiblePicks: mode === 'apply',
    spec,
    candidates: forSelect,
    annotated,
    flagged,
    observation: buildTotalsUnderPitcherObservationStatus({
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

export function writeTotalsUnderPitcherObserveSnapshot(payload) {
  const body = {
    generatedAt: new Date().toISOString(),
    overlayId: MLB_TOTALS_UNDER_PITCHER_SPEC.id,
    ...payload,
  };
  fs.writeFileSync(LIVE_SNAPSHOT, JSON.stringify(body, null, 2));
  return body;
}

export function buildTotalsUnderPitcherObservationStatus({ live = null } = {}) {
  const obs = MLB_TOTALS_UNDER_PITCHER_SPEC.observation;
  const isHistReplay = live?.source === 'historical_replay_hybrid_v11';
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
    diagnosis: MLB_TOTALS_UNDER_PITCHER_SPEC.diagnosis,
    historicalReplay: isHistReplay
      ? {
          flaggedBets: Number(live?.flaggedBets ?? live?.cutN ?? 0),
          deltaUsd50: live?.deltaUsd50 ?? null,
          byYear: live?.byYear ?? null,
          kept: live?.kept ?? null,
          cut: live?.cut ?? null,
          note: '歷史重放僅作基線參考，不計入活體樣本',
        }
      : null,
    live: isHistReplay
      ? {
          flaggedBets: 0,
          flaggedDays: 0,
          deltaUsd50: null,
          note: '觀察期以活體累積為準',
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
            note: '活體尚未寫入；先跑 report 腳本',
          },
    paperEvidence: MLB_TOTALS_UNDER_PITCHER_SPEC.paperEvidenceUsd50,
    rules: [
      `模式 off|compare|apply（環境 MLB_TOTALS_UNDER_PITCHER_SHADOW，預設 apply）`,
      `規則：Hybrid Under（raw_under）且 parkFactor<${MLB_TOTALS_UNDER_PITCHER_SPEC.rule.pitcherParkFactorMax} → 跳過`,
      `只動大小，不動獨贏；勿混鎖定 B TopK`,
      `升格閘：auditMlbTotalsUnderPitcherPromoteGate（pass）`,
      obs.promoteNote,
    ],
  };
}

export function getTotalsUnderPitcherObservationSummary() {
  const mode = resolveTotalsUnderPitcherMode();
  return {
    available: true,
    mode,
    enabled: isTotalsUnderPitcherEnabled(mode),
    appliesToVisiblePicks: mode === 'apply',
    spec: MLB_TOTALS_UNDER_PITCHER_SPEC,
    observation: buildTotalsUnderPitcherObservationStatus({
      live: loadLiveObserveSnapshot(),
    }),
    note:
      mode === 'off'
        ? 'Under×投手公園 overlay 關閉'
        : mode === 'apply'
          ? '已從 Hybrid 可看選邊剔除（非升格 v1.1 常數；設 compare|off 可退）'
          : '對照中：Hybrid 正式選邊不變，標註 wouldSkip',
  };
}
