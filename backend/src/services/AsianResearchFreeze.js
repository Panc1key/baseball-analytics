/**
 * 亞聯研究候選凍結（非正式、不進推薦、不碰 Locked B）
 */
export const ASIAN_RESEARCH_FREEZE = Object.freeze({
  id: 'asian_research_candidate_2026-08-04_npb_baseline',
  status: 'research_only',
  wiredToFormal: false,
  dataCoverageNote: {
    MLB: '2024–2026，~6200 場，歷史賠率齊',
    NPB: '2024–2026 盤口+比分已齊；先發：2026 Yahoo、2024/2025 npb.jp box',
    KBO: '2024–2026 盤口+比分已齊；先發：官網 GetKboGameList（含歷史）',
    betCountWhy:
      '多年 OOS 注數仍受門檻／warmup／無平手過濾影響；不是缺季。正式推薦仍關閉。',
  },
  starterSnapshots: {
    table: 'asian_probable_starter_snapshots',
    KBO: '2024:771 / 2025:792 / 2026:450',
    NPB: '2024:875 / 2025:878 / 2026:654',
  },
  candidates: {
    NPB_primary: {
      head: 'logistic_h2h',
      features: 'no_pitcher',
      shrink: 0.55,
      temp: 1.35,
      gate: 'mid',
      patches: {},
      oosHint:
        '無月過濾 baseline（主看）：173 注 勝率 56.7% ROI +9.3% @$50=+808；9 正 6 負月',
    },
    NPB_drop_aug_sep_experiment: {
      head: 'logistic_h2h',
      features: 'no_pitcher',
      shrink: 0.55,
      temp: 1.35,
      gate: 'mid',
      patches: { dropMonths: [8, 9] },
      oosHint:
        '實驗對照（非主看）：事後拿掉 8–9 月 → 131 注 ROI +14.5%；非每年皆弱，疑過擬合，不作決策依據',
    },
    NPB_mid_only_experiment: {
      head: 'logistic_h2h',
      features: 'no_pitcher',
      shrink: 0.55,
      temp: 1.35,
      gate: 'mid',
      patches: { keepMonths: [6, 7] },
      oosHint: '實驗對照：僅 6–7 月 46 注 ROI +23.8%；注少，不作主看',
    },
    KBO_noPitcher_safe: {
      head: 'logistic_h2h',
      features: 'no_pitcher',
      shrink: 0.4,
      temp: 1.15,
      gate: 'soft',
      patches: { maxEdge: 0.06, maxAbsGap: 0.06, maxOddsSoft: 2.25 },
      oosHint:
        '多年：136 注 ROI +9.6%；但 2025 −9%、月不穩；先發特徵未證明加分',
    },
    KBO_primary_pitcher: {
      head: 'logistic_h2h',
      features: 'pitcher_core',
      shrink: 0.4,
      temp: 1.15,
      gate: 'soft',
      patches: { maxEdge: 0.06, maxAbsGap: 0.06, maxOddsSoft: 2.25 },
      oosHint:
        '補齊歷史先發後多年 ROI −5.5%（201 注）；降級觀察，不升格',
    },
  },
  foldStability: {
    NPB_primary: '無月過濾；總體正但不穩（9/6）；不作日曆砍倉',
    NPB_drop_aug_sep: '已降級為實驗；主要被 2024-09 拖累，非三年共識',
    KBO: '暫時擱置，不納入 MLB+亞聯一日組合；先發線多年為負',
    focus: '只推進 NPB；KBO 不並行，避免決策混亂',
    verdict: 'NPB baseline 為唯一亞聯主看；禁止正式／紙上；KBO pause',
  },
  nextWork: [
    '主影子 ridge_poisson_cal_same；邊際層 mu_league_025（+$45）觀察中',
    '下一步影子：edge/EV 結構過濾、或 totals 機率（泊松對線）取代 gap 启发式',
    '先發已在 foundation：禁止再做 drop-pitcher；KBO 暫停；禁止正式／紙上',
  ],
  shadowProtocol: {
    module: 'AsianNpbResearchShadow.js',
    audit: 'scripts/auditNpbResearchShadow.mjs',
    optimizeAudit: 'scripts/auditNpbRidgeShadowOptimize.mjs',
    artifact: 'tmp-npb-research-shadow.json',
    savedPrimaryShadow: 'ridge_poisson_cal_same',
    savedImproveShadow: 'ridge_cal_mu_league_025',
    rule: '新想法只開影子；禁止改 NPB_primary 常數；不自動升格',
  },
  kboStatus: 'paused',
});

export const ASIAN_FEATURE_SET_NO_PITCHER = Object.freeze([
  'eloDiff',
  'eloStrength',
  'pythWinPct',
  'opponentPythWinPct',
  'seasonWinPct',
  'opponentSeasonWinPct',
  'runDiffPerGame',
  'opponentRunDiffPerGame',
  'last10WinPct',
  'opponentLast10WinPct',
  'formWinAccel',
  'rpgAccel',
  'restDiff',
  'seasonRpg',
  'opponentSeasonRpg',
  'seasonRaRpg',
  'opponentSeasonRaRpg',
]);

export const ASIAN_FEATURE_SET_PITCHER_CORE = Object.freeze([
  'eloDiff',
  'eloStrength',
  'pythWinPct',
  'opponentPythWinPct',
  'runDiffPerGame',
  'opponentRunDiffPerGame',
  'pitcherKnown',
  'opponentPitcherKnown',
  'pitcherRaDiff',
  'pitcherRestDays',
  'opponentPitcherRestDays',
  'pitcherStarts',
  'opponentPitcherStarts',
]);
