/**
 * MLB 大小分衛星（研究影子；不動鎖定 B 獨贏）。
 *
 * 2026-08-01：初版 MVP + 盤口≤10。
 * 2026-08-01 晚：Grok A/B/C → 閘門改 gap≥0.6 / EV≥3% / edge≥3%（三窗準正式過閘；仍不進紙上帳本）。
 */
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';

export const MLB_TOTALS_SATELLITE_SPEC = Object.freeze({
  id: 'totals_sat_v2026-08-01b',
  label: '大小分衛星（研究）',
  researchOnly: true,
  modelVersion: 'mlb-expected-runs-nb-v4.5',
  rules: Object.freeze({
    minAbsGap: 0.6,
    minimumExpectedValue: 0.03,
    minEdgeVsMarket: 0.03,
    minimumModelProbability: 0.52,
    dailyTopK: null,
    pickOddsMin: 1.5,
    pickOddsMax: 2.4,
    maxTotalLine: 10,
    /** 實驗 A：選注溫度校準未穩過閘；維持 T=1 */
    probabilityTemperature: 1,
  }),
  paperEvidenceUsd50: Object.freeze({
    windowNote:
      '2024-04～09 + 2025-04～09 + 2026-04～07；閘門 gap0.6/EV3%/edge3%/line≤10（Grok 實驗 B）',
    byYear: Object.freeze({
      '2024': Object.freeze({ bets: 740, hitRate: 0.5297, roi: 0.028, usd50: 1038 }),
      '2025': Object.freeze({ bets: 642, hitRate: 0.5327, roi: 0.0304, usd50: 976 }),
      '2026': Object.freeze({ bets: 424, hitRate: 0.5425, roi: 0.0527, usd50: 1117 }),
    }),
    merged: Object.freeze({ bets: 1806, hitRate: 0.5338, roi: 0.0347, usd50: 3131 }),
    holdout2026JunJul: Object.freeze({
      bets: 192,
      hitRate: 0.5677,
      roi: 0.0999,
      usd50: 960,
    }),
    auditScript: 'scripts/auditMlbTotalsSatGrokAbc.mjs',
    artifact: 'tmp-totals-sat-grok-abc.json',
  }),
  note:
    '準正式過閘（三窗 ROI≥0、合併≥3%、holdout≥5%），仍為影子：勿寫入 mlb_paper_bets、勿與鎖定 B 混 TopK。',
});

/**
 * 平行影子：同一 01b 閘門但只保留 Under（注少、三窗更肥）。
 * 不替換主衛星 both-sides；UI 另列觀察。
 * 2026-08-01 Grok：觀察過關後可單獨升紙上衛星帳本（仍不混 B／不替換 01b）。
 */
export const MLB_TOTALS_SATELLITE_UNDER_ONLY_SPEC = Object.freeze({
  id: 'totals_sat_under_only_v1',
  label: '大小分 Under 平行影子',
  researchOnly: true,
  parentSpecId: 'totals_sat_v2026-08-01b',
  rules: MLB_TOTALS_SATELLITE_SPEC.rules,
  sideFilter: 'under',
  paperEvidenceUsd50: Object.freeze({
    byYear: Object.freeze({
      '2024': Object.freeze({ bets: 90, hitRate: 0.6667, roi: 0.267, usd50: 1202 }),
      '2025': Object.freeze({ bets: 144, hitRate: 0.5903, roi: 0.1135, usd50: 817 }),
      '2026': Object.freeze({ bets: 64, hitRate: 0.5469, roi: 0.0269, usd50: 86 }),
    }),
    merged: Object.freeze({ bets: 298, hitRate: 0.604, roi: 0.1412, usd50: 2104 }),
    auditScript: 'scripts/auditMlbTotalsSatUnderOnly3y.mjs',
    artifact: 'tmp-totals-sat-under-only-3y.json',
  }),
  note:
    '01b 閘門內只取小；三窗皆正但注少。平行觀察，不替換主衛星；過關後可單獨升紙上衛星帳本（不混鎖定 B）。',
});

/**
 * Under 平行影子 → 單獨紙上衛星帳本（門檻略低於 01b both；尚未接帳本）。
 */
export const MLB_TOTALS_UNDER_ONLY_PAPER_PROMOTE_GATES = Object.freeze({
  id: 'totals-under-only-paper-promote-v1',
  observation: Object.freeze({
    minCalendarDays: 14,
    minLiveShadowBets: 25,
    minDistinctSlateDaysWithPick: 8,
    note: '注少線：略降觀察門檻；仍要求活體非崩',
  }),
  earlyPromoteIf: Object.freeze({
    minLiveShadowBets: 25,
    minDistinctSlateDaysWithPick: 8,
    liveRoiGe: 0,
    preferredLiveRoiGe: 0.02,
  }),
  stopLiveIf: Object.freeze({
    liveRoiLeNeg5AfterMinBets: Object.freeze({ roi: -0.05, minBets: 15 }),
    consecutivePickDaysNetLoss: 8,
  }),
  afterPromote: Object.freeze({
    ledgerName: 'under_satellite_paper',
    mixWithLockedB: false,
    mixWithTotals01b: false,
    replaceTotals01b: false,
  }),
  stillForbidden: Object.freeze([
    'replace_01b_main_satellite',
    'mix_with_locked_b',
    'retune_01b_gates',
    'open_run_line',
    'open_team_totals_event_odds',
  ]),
});

/**
 * 準正式影子 → 紙上衛星帳本 的最低觀察／過閘條件（文件化；尚未接帳本）。
 * 正式鎖定 B 獨贏帳本與此無關。
 * 2026-08-01 Grok：觀察期內零優化；過關先做穩紙上衛星帳本，再考慮讓分。
 */
export const MLB_TOTALS_SATELLITE_PAPER_PROMOTE_GATES = Object.freeze({
  id: 'totals-sat-paper-promote-v1',
  observation: Object.freeze({
    minCalendarDays: 21,
    minLiveShadowBets: 40,
    minDistinctSlateDaysWithPick: 10,
    note: '活體影子觀察：日內注數不過稀、執行穩定後才談紙上衛星帳本',
  }),
  /** 可提前升（不必等滿 21 日） */
  earlyPromoteIf: Object.freeze({
    minLiveShadowBets: 40,
    minDistinctSlateDaysWithPick: 10,
    liveRoiGe: 0,
    preferredLiveRoiGe: 0.02,
    noPathologicalRecovery: true,
    note: '滿 40 注＋≥10 有選邊日＋活體 ROI≥0（最好≥+2%），且非單周崩盤後翻本',
  }),
  /** 喊停／降回純影子（先停實盤大小分） */
  stopLiveIf: Object.freeze({
    liveRoiLeNeg5AfterMinBets: Object.freeze({ roi: -0.05, minBets: 25 }),
    consecutivePickDaysNetLoss: 10,
    abnormalDailyVolumeVsBacktest: true,
    note: 'ROI≤−5% 且≥25 注；或連續 10 個有選邊日淨虧且背離 2026 回測；或日注異常暴增／暴減',
  }),
  historicalMustHold: Object.freeze({
    allWindowsRoiGe0: true,
    windows: ['2024', '2025', '2026'],
    mergedRoiGe: 0.03,
    minBetsPerWindow: 200,
    holdout2026JunJulRoiGe: 0.05,
  }),
  liveShadowMustHold: Object.freeze({
    liveRoiGe0: true,
    maxDaysWithZeroPicksShare: 0.5,
    note: '觀察期內有選邊日占比不過低；活體 ROI 非負（樣本≥40）',
  }),
  afterPaperLedger: Object.freeze({
    confirmWeeks: Object.freeze({ min: 2, max: 4 }),
    nextMarket: 'none_until_under_and_01b_stable',
    laterMarket: 'team_total_event_odds_reeval',
    shelvedMarkets: Object.freeze(['run_line']),
    note:
      '紙上衛星帳本穩定後才重評隊總分；讓分正式擱置。下一刀唯一優先：Under 平行影子觀察→單獨帳本。',
  }),
  stillForbiddenDuringObservation: Object.freeze([
    'retune_gap_ev_edge_max_line',
    'temperature_into_selection',
    'side_only_over_or_under_as_01b_replacement',
    'totals_daily_topk',
    'mix_with_locked_b_topk',
    'run_line_team_total_props',
    'new_features_models_weather_hard_rules',
    'relax_locked_b_for_volume',
    'change_totals_constants_on_daily_weekly_pnl',
    'write_into_mlb_paper_bets_h2h_ledger',
    'open_run_line_satellite',
    'backfill_team_totals_event_odds_now',
  ]),
});

/**
 * 同一庄家 Over/Under 成對取低水主線。
 */
export function bestFairTotals(bookmakers = []) {
  let selected = null;
  let bookCount = 0;
  for (const book of bookmakers) {
    const market = book.markets?.find((m) => m.key === 'totals');
    if (!market?.outcomes?.length) continue;
    for (const over of market.outcomes) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = market.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over?.price || !under?.price) continue;
      const overOdds = Number(over.price);
      const underOdds = Number(under.price);
      if (!Number.isFinite(overOdds) || !Number.isFinite(underOdds)) continue;
      bookCount += 1;
      const overImplied = decimalToImpliedProb(overOdds);
      const underImplied = decimalToImpliedProb(underOdds);
      if (!overImplied || !underImplied) continue;
      const margin = overImplied + underImplied - 1;
      if (!selected || margin < selected.margin) {
        const fair = removeVig(overImplied, underImplied);
        selected = {
          bookmaker: book.title || book.key || 'unknown',
          line: Number(over.point),
          overOdds,
          underOdds,
          fairOver: fair.fairA,
          fairUnder: fair.fairB,
          margin,
        };
      }
    }
  }
  if (!selected) return null;
  return { ...selected, totalsBookCount: bookCount };
}

/**
 * @returns {{ tier: 'actionable'|'blocked', side: 'over'|'under'|null, reasons: string[], ... }}
 */
export function classifyMlbTotalsSatelliteCandidate({
  prediction,
  totalsMarket,
  spec = MLB_TOTALS_SATELLITE_SPEC,
} = {}) {
  const rules = spec.rules || MLB_TOTALS_SATELLITE_SPEC.rules;
  const reasons = [];
  if (!prediction || !Number.isFinite(Number(prediction.expectedTotal))) {
    return {
      tier: 'blocked',
      market: 'totals',
      side: null,
      reasons: ['totals_prediction_missing'],
      researchOnly: true,
      specId: spec.id,
    };
  }
  if (!totalsMarket || !Number.isFinite(Number(totalsMarket.line))) {
    return {
      tier: 'blocked',
      market: 'totals',
      side: null,
      reasons: ['totals_market_missing'],
      researchOnly: true,
      specId: spec.id,
    };
  }

  const line = Number(totalsMarket.line);
  const expectedTotal = Number(prediction.expectedTotal);
  const pushP = Number(prediction.markets?.total?.pushProbability) || 0;
  const overRaw = Number(prediction.markets?.total?.overProbability);
  const underRaw = Number(prediction.markets?.total?.underProbability);
  if (!Number.isFinite(overRaw) || !Number.isFinite(underRaw)) {
    return {
      tier: 'blocked',
      market: 'totals',
      side: null,
      line,
      expectedTotal,
      reasons: ['totals_probability_missing'],
      researchOnly: true,
      specId: spec.id,
    };
  }

  const overProb = overRaw / Math.max(1e-9, 1 - pushP);
  const underProb = underRaw / Math.max(1e-9, 1 - pushP);
  const gap = expectedTotal - line;
  const absGap = Math.abs(gap);
  const pickOver = gap > 0;

  if (pickOver && overProb < 0.5) reasons.push('mean_prob_disagree');
  if (!pickOver && underProb < 0.5) reasons.push('mean_prob_disagree');

  const modelProb = pickOver ? overProb : underProb;
  const pickOdds = pickOver ? Number(totalsMarket.overOdds) : Number(totalsMarket.underOdds);
  const fairPick = pickOver ? Number(totalsMarket.fairOver) : Number(totalsMarket.fairUnder);
  const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
  const edgeVsMarket = modelProb - fairPick;

  if (absGap < rules.minAbsGap) reasons.push('abs_gap_below_threshold');
  if (ev < rules.minimumExpectedValue) reasons.push('expected_value_below_threshold');
  if (edgeVsMarket < rules.minEdgeVsMarket) reasons.push('edge_vs_market_below_threshold');
  if (modelProb < rules.minimumModelProbability) reasons.push('model_probability_below_threshold');
  if (pickOdds < rules.pickOddsMin) reasons.push('pick_odds_below_minimum');
  if (pickOdds > rules.pickOddsMax) reasons.push('pick_odds_above_maximum');
  if (
    Number.isFinite(Number(rules.maxTotalLine)) &&
    line > Number(rules.maxTotalLine)
  ) {
    reasons.push('total_line_above_maximum');
  }

  const side = pickOver ? 'over' : 'under';
  return {
    tier: reasons.length ? 'blocked' : 'actionable',
    market: 'totals',
    side,
    line,
    pick: pickOver ? `大 ${line}` : `小 ${line}`,
    expectedTotal,
    absGap,
    modelProbability: modelProb,
    marketProbability: fairPick,
    expectedValue: ev,
    edgeVsMarket,
    oddsDecimal: pickOdds,
    overOdds: totalsMarket.overOdds,
    underOdds: totalsMarket.underOdds,
    bookmaker: totalsMarket.bookmaker || null,
    reasons,
    researchOnly: true,
    specId: spec.id,
  };
}

export function selectDailyTotalsSatellitePicks(candidates, spec = MLB_TOTALS_SATELLITE_SPEC) {
  const actionable = (candidates || []).filter((c) => c?.tier === 'actionable');
  const topK = spec.rules?.dailyTopK;
  if (!topK) return actionable;
  const byDay = new Map();
  for (const c of actionable) {
    const day = c.researchDay || c.day || 'unknown';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    out.push(
      ...[...byDay.get(day)]
        .sort(
          (a, b) =>
            (b.expectedValue || 0) - (a.expectedValue || 0) ||
            (b.absGap || 0) - (a.absGap || 0)
        )
        .slice(0, topK)
    );
  }
  return out;
}
