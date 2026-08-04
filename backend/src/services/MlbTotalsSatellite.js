/**
 * MLB 大小分衛星（研究影子；不動鎖定 B 獨贏）。
 *
 * 2026-08-01：初版 MVP + 盤口≤10。
 * 2026-08-01 晚：Grok A/B/C → 閘門改 gap≥0.6 / EV≥3% / edge≥3%。
 * 2026-08-03：Hybrid 主打（raw Under + 投手公園去偏 Over）；均注 $50。
 */
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import {
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
} from './MlbExpectedRunsModel.js';

export const MLB_TOTALS_SATELLITE_SPEC = Object.freeze({
  id: 'totals_sat_v2026-08-01b',
  label: '大小分 both（對照研究）',
  researchOnly: true,
  primarySatellite: false,
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
    'both 寬線對照；預設主打為 hybrid。勿寫入 mlb_paper_bets、勿與鎖定 B 混 TopK。',
});

/**
 * Under-only：平行對照（均注 $50；不混鎖定 B TopK）。
 * 2026-08-03：曾作主打；2026-08-03 晚主打改 hybrid（raw Under + 投手公園去偏 Over）。
 */
export const MLB_TOTALS_SATELLITE_UNDER_ONLY_SPEC = Object.freeze({
  id: 'totals_sat_under_only_v1',
  label: '大小分 Under 對照',
  researchOnly: true,
  primarySatellite: false,
  suggestedStakeUsd: 50,
  parentSpecId: 'totals_sat_v2026-08-01b',
  rules: MLB_TOTALS_SATELLITE_SPEC.rules,
  sideFilter: 'under',
  paperEvidenceUsd50: Object.freeze({
    byYear: Object.freeze({
      '2024': Object.freeze({ bets: 81, hitRate: 0.6543, roi: 0.2604, usd50: 1055 }),
      '2025': Object.freeze({ bets: 136, hitRate: 0.5515, roi: 0.0655, usd50: 445 }),
      '2026': Object.freeze({ bets: 61, hitRate: 0.5574, roi: 0.0811, usd50: 247 }),
    }),
    merged: Object.freeze({ bets: 278, hitRate: 0.5827, roi: 0.1257, usd50: 1748 }),
    auditScript: 'scripts/auditMlbTotalsSatNextKnifeProfit.mjs',
    artifact: 'tmp-totals-sat-next-knife-profit.json',
  }),
  note:
    '01b 閘門內只取小；均注 $50。現為對照線；主打見 hybrid。',
});

/**
 * Hybrid 主打：Under=raw μ；Over=僅投手公園（parkFactor&lt;0.97）扣凍結 offset。
 * 2026-08-04：Over·raw 另加 absGap≤1.25（砍過度自信厚邊）；納入鎖定 B 組合包。
 * 均注 $50。不混鎖定 B TopK／不寫入獨贏紙上帳本。
 */
export const MLB_TOTALS_SATELLITE_HYBRID_SPEC = Object.freeze({
  id: 'totals_sat_hybrid_v1.1',
  label: '大小分 Hybrid 衛星（主打）',
  researchOnly: false,
  primarySatellite: true,
  suggestedStakeUsd: 50,
  parentSpecId: 'totals_sat_v2026-08-01b',
  rules: MLB_TOTALS_SATELLITE_SPEC.rules,
  /** 投手公園判定 */
  pitcherParkFactorMax: 0.97,
  /**
   * 凍結：pitcher_park 上 mean(μ−line)。
   * 來源 auditMlbTotalsCalibParkOos / hybrid OOS（≈0.706）；取 0.70。
   */
  pitcherParkMuMinusLineOffset: 0.7,
  /**
   * Over 專用收緊：|μ−線|≥0.9（Under 仍用 rules.minAbsGap=0.6）。
   * auditMlbTotalsHybridOverTighten：勝率 +0.17pp、ROI 微升、三窗仍正；再抬 EV/prob 反而變差。
   */
  overMinAbsGap: 0.9,
  /**
   * 僅 Over·raw（非投手去偏）：|μ−線|上限。厚邊 Over·raw 更差（rigor + best-scheme）。
   * auditMlbTotalsHybridBestScheme：cap1.25 三年皆贏 baseline，注數 1387→787、勝率 55.2%→58.3%、Δ$+507。
   * 回滾：`.env` MLB_TOTALS_RAW_OVER_MAX_ABS_GAP=off
   */
  rawOverMaxAbsGap: 1.25,
  paperEvidenceUsd50: Object.freeze({
    byYear: Object.freeze({
      '2024': Object.freeze({
        both: Object.freeze({
          bets: 301,
          hitRate: 0.5748,
          roi: 0.1182,
          usd50: 1779,
        }),
      }),
      '2025': Object.freeze({
        both: Object.freeze({
          bets: 293,
          hitRate: 0.5904,
          roi: 0.1455,
          usd50: 2132,
        }),
      }),
      '2026': Object.freeze({
        both: Object.freeze({
          bets: 193,
          hitRate: 0.5855,
          roi: 0.1408,
          usd50: 1359,
        }),
      }),
    }),
    merged: Object.freeze({
      both: Object.freeze({
        bets: 787,
        hitRate: 0.5832,
        roi: 0.1339,
        usd50: 5270,
        note: 'v1.1：overMinAbsGap=0.9 + rawOverMaxAbsGap=1.25',
      }),
      vsV1NoCap: Object.freeze({
        bets: 1387,
        hitRate: 0.5523,
        roi: 0.0687,
        usd50: 4763,
        deltaUsd: 507,
      }),
    }),
    auditScript: 'scripts/auditMlbTotalsHybridBestScheme.mjs',
    artifact: 'tmp-totals-hybrid-best-scheme.json',
  }),
  note:
    'Under raw gap≥0.6；Over 投手去偏 gap≥0.9；Over·raw 另限 absGap≤1.25。均注 $50。勿混鎖定 B TopK。',
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

/**
 * 將總分 μ 平移 totalOffset（負=下修），重算大小分機率；獨贏市場不重算。
 */
export function shiftTotalsPredictionMeans(prediction, totalOffset, totalLine) {
  const home0 = Number(prediction?.homeExpectedRuns);
  const away0 = Number(prediction?.awayExpectedRuns);
  if (!Number.isFinite(home0) || !Number.isFinite(away0)) return prediction;
  const half = Number(totalOffset) / 2;
  const homeMu = Math.max(0.5, home0 + half);
  const awayMu = Math.max(0.5, away0 + half);
  const dispersion = Number(prediction?.dispersion) || 1;
  const line = Number(
    totalLine ?? prediction?.markets?.total?.line ?? 8.5
  );
  const dist = buildMlbScoreDistribution({
    homeMean: homeMu,
    awayMean: awayMu,
    homeDispersion: dispersion,
    awayDispersion: dispersion,
  });
  const markets = deriveMlbScoreMarkets(dist, { totalLine: line });
  return {
    ...prediction,
    homeExpectedRuns: homeMu,
    awayExpectedRuns: awayMu,
    expectedTotal: homeMu + awayMu,
    markets: {
      ...(prediction.markets || {}),
      total: markets.total,
    },
    totalsMeanShift: {
      totalOffset,
      from: home0 + away0,
      to: homeMu + awayMu,
    },
  };
}

/**
 * Hybrid：Under 用 raw；Over 在投手公園對 μ 扣凍結 offset 後再分類。
 */
export function classifyMlbTotalsHybridCandidate({
  prediction,
  totalsMarket,
  parkFactor = 1,
  spec = MLB_TOTALS_SATELLITE_HYBRID_SPEC,
} = {}) {
  const pitcherMax = Number(spec.pitcherParkFactorMax) || 0.97;
  const offset = Number(spec.pitcherParkMuMinusLineOffset) || 0.7;
  const pf = Number(parkFactor);
  const isPitcherPark = Number.isFinite(pf) && pf < pitcherMax;

  const raw = classifyMlbTotalsSatelliteCandidate({
    prediction,
    totalsMarket,
    spec: { ...spec, id: spec.id, rules: spec.rules || MLB_TOTALS_SATELLITE_SPEC.rules },
  });

  if (raw.tier === 'actionable' && raw.side === 'under') {
    return {
      ...raw,
      researchOnly: Boolean(spec.researchOnly),
      specId: spec.id,
      hybridPath: 'raw_under',
      pitcherParkDebiasApplied: false,
      parkFactor: pf,
    };
  }

  const overPrediction = isPitcherPark
    ? shiftTotalsPredictionMeans(prediction, -offset, totalsMarket?.line)
    : prediction;
  const overCls = classifyMlbTotalsSatelliteCandidate({
    prediction: overPrediction,
    totalsMarket,
    spec: {
      ...spec,
      id: spec.id,
      rules: {
        ...(spec.rules || MLB_TOTALS_SATELLITE_SPEC.rules),
        minAbsGap: Number.isFinite(Number(spec.overMinAbsGap))
          ? Number(spec.overMinAbsGap)
          : Number(spec.rules?.minAbsGap ?? MLB_TOTALS_SATELLITE_SPEC.rules.minAbsGap),
      },
    },
  });

  if (overCls.tier === 'actionable' && overCls.side === 'over') {
    const hybridPath = isPitcherPark ? 'pitcher_debiased_over' : 'raw_over';
    const rawOverMax = Number(spec.rawOverMaxAbsGap);
    if (
      hybridPath === 'raw_over' &&
      Number.isFinite(rawOverMax) &&
      rawOverMax > 0 &&
      Number(overCls.absGap) > rawOverMax
    ) {
      return {
        tier: 'blocked',
        market: 'totals',
        side: 'over',
        reasons: [
          ...(overCls.reasons || []).map((r) => `overPath:${r}`),
          'raw_over_abs_gap_above_maximum',
        ],
        researchOnly: Boolean(spec.researchOnly),
        specId: spec.id,
        hybridPath: null,
        pitcherParkDebiasApplied: false,
        parkFactor: pf,
        absGap: overCls.absGap,
        rawOverMaxAbsGap: rawOverMax,
        expectedTotalRaw: Number(prediction?.expectedTotal),
        line: overCls.line,
        pick: overCls.pick,
        oddsDecimal: overCls.oddsDecimal,
      };
    }
    return {
      ...overCls,
      researchOnly: Boolean(spec.researchOnly),
      specId: spec.id,
      hybridPath,
      pitcherParkDebiasApplied: isPitcherPark,
      parkFactor: pf,
      expectedTotalRaw: Number(prediction?.expectedTotal),
      overMinAbsGap: Number(spec.overMinAbsGap) || null,
      rawOverMaxAbsGap: Number.isFinite(rawOverMax) ? rawOverMax : null,
    };
  }

  return {
    tier: 'blocked',
    market: 'totals',
    side: null,
    reasons: [
      ...(raw.reasons || []).map((r) => `raw:${r}`),
      ...(overCls.reasons || []).map((r) => `overPath:${r}`),
      'hybrid_no_actionable_side',
    ],
    researchOnly: Boolean(spec.researchOnly),
    specId: spec.id,
    hybridPath: null,
    pitcherParkDebiasApplied: isPitcherPark,
    parkFactor: pf,
  };
}
