/**
 * MLB 預期得分地基模型。
 *
 * 一個共享的賽前特徵模型分別估計主客隊得分均值，再用負二項分布推導
 * 獨贏、讓分與大小球。市場賠率只用於外測，不進入模型。
 */
import { randomUUID } from 'crypto';
import db from '../db/database.js';
import { resolveMlbParkFactor } from '../data/parkFactors.js';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import { MLB_BASELINE_FEATURE_VERSION } from './MlbHistoricalBaseline.js';
import {
  buildMlbWeatherFeatureVector,
  getCachedMlbGameWeather,
} from './MlbGameWeatherService.js';
import { resolvePitOdds } from './PitOddsService.js';
import {
  applySoftRegimeAdjustment,
  buildPregameRegimeSignals,
  scoreGameRegimeFromPregame,
} from './MlbGameRegimeService.js';
import {
  buildMlbRegimeTotalsLeanDecision,
  resolveMlbRegimeMarketPlan,
} from './MlbRegimeMarketRouter.js';
import { config } from '../config.js';
import { MLB_PAPER_RULE_FREEZE } from './MlbPaperRuleFreeze.js';

/** 鎖定 B 毒客收縮常數（與 MlbFrozenBShadow / Locked overlay 凍結一致） */
const LOCKED_B_TOXIC_SHRINK = Object.freeze({
  w: 0.45,
  modelProbMin: 0.55,
  strongHomeWinPct: 0.65,
});

function applyLockedBToxicShrinkInline(modelProb, pickOdds, { pickHome, homeWinPct }) {
  if (config.mlbLockedBOverlayEnabled === false) return modelProb;
  const toxicAway = !pickHome && (homeWinPct ?? 0) >= LOCKED_B_TOXIC_SHRINK.strongHomeWinPct;
  if (!toxicAway || modelProb < LOCKED_B_TOXIC_SHRINK.modelProbMin) return modelProb;
  const market = 1 / pickOdds;
  return modelProb * (1 - LOCKED_B_TOXIC_SHRINK.w) + market * LOCKED_B_TOXIC_SHRINK.w;
}

export const MLB_EXPECTED_RUNS_MODEL_VERSION = 'mlb-expected-runs-nb-v4.5';
/** 研究版；過雙層閘後才可升格為正式 v4.6 */
export const MLB_EXPECTED_RUNS_V46_RC_MODEL_VERSION = 'mlb-expected-runs-nb-v4.6-rc';
export const MLB_EXPECTED_RUNS_V46_RC2_MODEL_VERSION = 'mlb-expected-runs-nb-v4.6-rc2';
/** v4.6 凍結：對手先發身份異常（不進 fallback；不改 v4.5 消融表） */
export const MLB_EXPECTED_RUNS_STARTER_IDENTITY_FEATURE_KEYS = [
  'opponentStarterIsReturnFromIl',
  'opponentStarterIsSparseStart',
];
/** v4.6-rc2：同一訊號的連續值表達 */
export const MLB_EXPECTED_RUNS_STARTER_IDENTITY_CONTINUOUS_KEYS = [
  'opponentStarterDaysSinceIlExit',
  'opponentStarterSeasonGs',
];
/** daysSinceIlExit 缺省（無 IL 啟動紀錄）填此大數，避免 NaN */
export const MLB_IL_DAYS_SINCE_EXIT_MISSING = 365;
/** sparseStart：GS∈[1,3] 且該隊賽前場次 ≥ 此值（開季保護） */
export const MLB_SPARSE_START_MIN_TEAM_GAMES = 15;
export const MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS = [
  'isHome',
  'offenseRecentRpg',
  'opponentRecentRaRpg',
  'opponentStarterEraContribution',
  'opponentStarterWhipContribution',
  'opponentStarterKMinusBb9Contribution',
  'opponentStarterRecentEraContribution',
  'opponentStarterExpectedInnings',
  'opponentStarterRestDays',
];
export const MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS = [
  'offenseObp',
  'offenseSlg',
  'offenseKMinusBbRate',
];
export const MLB_EXPECTED_RUNS_BULLPEN_FEATURE_KEYS = [
  'opponentBullpenEraContribution',
  'opponentBullpenWhipContribution',
];
export const MLB_EXPECTED_RUNS_STARTER_STRENGTH_FEATURE_KEYS = [
  'opponentStarterHr9Contribution',
  'opponentStarterFipContribution',
  'opponentStarterRecentKMinusBbContribution',
  'offenseVsStarterEraGap',
];
export const MLB_EXPECTED_RUNS_BULLPEN_STRENGTH_FEATURE_KEYS = [
  'opponentBullpenHr9Contribution',
  'opponentBullpenKMinusBbContribution',
  'opponentBullpenPitchesLast3',
];
export const MLB_EXPECTED_RUNS_PLATOON_FEATURE_KEYS = [
  'opponentStarterIsLefty',
  'opponentStarterOpsVsLhb',
  'opponentStarterOpsVsRhb',
  'offenseOpsVsStarterHand',
];
export const MLB_EXPECTED_RUNS_PARK_FEATURE_KEYS = [
  'parkFactor',
];
export const MLB_EXPECTED_RUNS_WEATHER_FEATURE_KEYS = [
  'gameTemperatureC',
  'gameWindSpeedKph',
  'gamePrecipProbability',
];
export const MLB_EXPECTED_RUNS_FEATURE_KEYS = [
  'isHome',
  'parkFactor',
  'offenseRecentRpg',
  ...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
  'opponentRecentRaRpg',
  'opponentStarterEraContribution',
  'opponentStarterWhipContribution',
  'opponentStarterKMinusBb9Contribution',
  'opponentStarterRecentEraContribution',
  ...MLB_EXPECTED_RUNS_STARTER_STRENGTH_FEATURE_KEYS,
  ...MLB_EXPECTED_RUNS_PLATOON_FEATURE_KEYS,
  ...MLB_EXPECTED_RUNS_BULLPEN_FEATURE_KEYS,
  ...MLB_EXPECTED_RUNS_BULLPEN_STRENGTH_FEATURE_KEYS,
  'opponentStarterExpectedInnings',
  'opponentStarterRestDays',
  ...MLB_EXPECTED_RUNS_STARTER_IDENTITY_FEATURE_KEYS,
  ...MLB_EXPECTED_RUNS_STARTER_IDENTITY_CONTINUOUS_KEYS,
  ...MLB_EXPECTED_RUNS_WEATHER_FEATURE_KEYS,
];
export const MLB_EXPECTED_RUNS_FALLBACK_FEATURE_KEYS = [
  'isHome',
  'parkFactor',
  'offenseRecentRpg',
  ...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
  'opponentRecentRaRpg',
  ...MLB_EXPECTED_RUNS_BULLPEN_FEATURE_KEYS,
  ...MLB_EXPECTED_RUNS_BULLPEN_STRENGTH_FEATURE_KEYS,
  ...MLB_EXPECTED_RUNS_WEATHER_FEATURE_KEYS,
];
/**
 * 嚴格研究方向門檻（持續實驗；主線跟 B：長賠過線）。
 * 舊「勝率線 A」（分差≥1）walk-forward 未過自身短賠線，勿與下方 profile id 混淆。
 * B 基線 + 軟過濾：maxOdds≤2.2、選邊 earlyExits 不高於對手。
 * 日內排序：按 EV，並對高 EV 毒區做條件罰分（P2）：
 *   EV≥0.12 且 modelProb∈[0.53,0.56) → score = EV - 0.15
 * 選注：凍結點 minOdds≥1.85 + 雙先發 ID + dailyTopK=3；
 *       實驗候選 ev02_max230（EV≥2% + maxOdds≤2.30 + dropR3 margin<0.50）。
 * 複驗：auditMlbStrictRuleWalkForward.mjs / auditMlbMinOddsAb.mjs /
 *       auditMlbIdentityScanOnMin185.mjs /
 *       auditMlbThresholdRelaxOnFrozen.mjs /
 *       auditMlbDailyDropR3MarginWf.mjs /
 *       tmp-lineb-p2-strict-wf.json / tmp-mlb-minodds-ab.json /
 *       tmp-identity-scan-on-min185.json /
 *       tmp-threshold-relax-on-frozen.json /
 *       tmp-daily-drop-r3-margin-wf.json
 */
const MLB_MONEYLINE_RULES_BASE = Object.freeze({
  minimumModelProbability: 0.5,
  minimumExpectedRunMargin: 0.25,
  minimumExpectedValue: 0.03,
  minimumPickOdds: null,
  maximumPickOdds: 2.2,
  /**
   * 日內第 3 名分差低於此則當日只取 Top2（null=關閉）。
   * 僅實驗 profile 覆寫；凍結點保持 null。
   */
  dropThirdIfMarginBelow: null,
  /**
   * 日內第 2 名賠率 ∈[dropSecondIfOddsMin, dropSecondIfOddsBelow) 則去掉 R2（可保留 R3）。
   * null=關閉。第三刀 WF：固定 1.95 過閘。
   */
  dropSecondIfOddsBelow: null,
  dropSecondIfOddsMin: 1.85,
  /**
   * 兩邊獨贏價都不得低於此（擋 1.01/34 這類歷史髒盤）。
   * null = 不檢查。
   */
  minimumEitherSideOdds: 1.2,
  /**
   * PIT 快照內完整雙邊 h2h 最少庄數（擋單莊畸形盤）。
   * null = 不檢查。多莊掃描 2026-07-27：≥2 過嚴格閘。
   */
  minimumH2hBookmakers: null,
  requirePickEarlyExitsNotHigher: true,
  /**
   * 選邊 earlyExits 高於對手時，日內排序扣分（不硬擋）。
   * null／0 = 關閉；與 requirePickEarlyExitsNotHigher 互斥使用（軟罰時應關硬擋）。
   */
  earlyExitsSoftPenaltyLambda: null,
  /** 雙方先發身份 ID 皆需可解析（資料品質閘；identity 掃描 2026-07-27 通過） */
  requireBothPitcherIdentities: false,
  maximumAbsoluteZScore: 3.5,
  dailyTopK: 3,
  /** 日內 TopK 主鍵：penalized EV（不是裸 modelProb） */
  dailyRankBy: 'penalized_ev',
  highEvRankPenaltyLambda: 0.15,
  highEvRankPenaltyMinEv: 0.12,
  highEvRankPenaltyProbMin: 0.53,
  highEvRankPenaltyProbMaxExclusive: 0.56,
});

/** 紙上選注 profile：frozen_v1=可回滾凍結點；min185=同凍結；其餘僅對照／實驗 */
export const MLB_MONEYLINE_RULE_PROFILES = Object.freeze({
  base_p2: Object.freeze({
    ...MLB_MONEYLINE_RULES_BASE,
    id: 'base_p2',
    label: 'B+P2（無 minOdds）',
  }),
  min185: Object.freeze({
    ...MLB_MONEYLINE_RULES_BASE,
    id: 'min185',
    label: 'B+P2 + minOdds≥1.85 + 雙先發 ID',
    minimumPickOdds: 1.85,
    requireBothPitcherIdentities: true,
    minimumH2hBookmakers: 2,
  }),
  /** 與 min185 數值鎖定一致；改實驗時勿覆蓋此物件 */
  frozen_v1: Object.freeze({
    ...MLB_MONEYLINE_RULES_BASE,
    ...MLB_PAPER_RULE_FREEZE.rules,
    id: 'frozen_v1',
    label: `凍結 ${MLB_PAPER_RULE_FREEZE.freezeId}`,
    freezeId: MLB_PAPER_RULE_FREEZE.freezeId,
  }),
  /**
   * 門檻放寬掃描過嚴格閘（2026-07-27）：
   * EV≥2% + maxOdds≤2.30；其餘同 frozen_v1。
   * 2026-07-28：日內第3名 margin<0.50 → 當日只取 Top2（WF 過閘）。
   * 2026-07-28：日內第2名賠率∈[1.85,1.95) → 去掉 R2（WF 過閘）。
   * 2026-07-30：earlyExits 硬擋 → 軟罰 λ=0.20（volume-lift 影子+expanding WF 過閘）。
   * 複跑：auditMlbThresholdRelaxOnFrozen.mjs /
   *       auditMlbDailyDropR3MarginWf.mjs /
   *       auditMlbDailyDropR2LowOddsWf.mjs /
   *       auditMlbVolumeLiftShadowOnEv02.mjs /
   *       auditMlbVolumeLiftEarlySoftExpandingWf.mjs → ev02_max230
   */
  ev02_max230: Object.freeze({
    ...MLB_MONEYLINE_RULES_BASE,
    ...MLB_PAPER_RULE_FREEZE.rules,
    id: 'ev02_max230',
    label: 'EV≥2% + maxOdds≤2.30 + dropR3/R2 + early軟罰0.20',
    minimumExpectedValue: 0.02,
    maximumPickOdds: 2.3,
    minimumPickOdds: 1.85,
    requireBothPitcherIdentities: true,
    minimumH2hBookmakers: 2,
    /** 第3名 expectedRunMargin 低於此則當日有效 TopK=2（不補第4） */
    dropThirdIfMarginBelow: 0.5,
    /** 第2名賠率∈[1.85,1.95) 則去掉 R2（可保留已過 dropR3 的 R3） */
    dropSecondIfOddsBelow: 1.95,
    dropSecondIfOddsMin: 1.85,
    /** 早退改軟罰：不硬擋，日內排序扣 0.20 */
    requirePickEarlyExitsNotHigher: false,
    earlyExitsSoftPenaltyLambda: 0.2,
  }),
  sweet_195_220: Object.freeze({
    ...MLB_MONEYLINE_RULES_BASE,
    id: 'sweet_195_220',
    label: 'B+P2 + 1.95–2.20（研究）',
    minimumPickOdds: 1.95,
    maximumPickOdds: 2.2,
    requireBothPitcherIdentities: true,
    minimumH2hBookmakers: 2,
  }),
});

export function resolveMlbMoneylineRuleProfile(profileId = null) {
  const id =
    profileId ||
    config.mlbPaperRuleProfile ||
    MLB_PAPER_RULE_FREEZE.profileId ||
    'frozen_v1';
  return MLB_MONEYLINE_RULE_PROFILES[id] || MLB_MONEYLINE_RULE_PROFILES.frozen_v1;
}

/** 正式紙上規則：可由 MLB_PAPER_RULE_PROFILE 切換；預設凍結點 */
export const MLB_MONEYLINE_RECOMMENDATION_RULES = resolveMlbMoneylineRuleProfile();

/**
 * 日內排序分數：預設 EV；命中高 EV 毒區時扣 λ；
 * earlyExits 軟罰（pickEarlyExitsHigher）再扣 earlyExitsSoftPenaltyLambda。
 * 僅影響排序，不改變 recommendation／blocked 分類門檻（軟罰模式下）。
 */
export function scoreMlbMoneylineDailyRank(
  { expectedValue, modelProbability, pickEarlyExitsHigher } = {},
  rules = MLB_MONEYLINE_RECOMMENDATION_RULES
) {
  const ev = Number(expectedValue);
  const p = Number(modelProbability);
  if (!Number.isFinite(ev)) return Number.NEGATIVE_INFINITY;
  const lambda = Number(rules.highEvRankPenaltyLambda) || 0;
  const minEv = Number(rules.highEvRankPenaltyMinEv);
  const pMin = Number(rules.highEvRankPenaltyProbMin);
  const pMax = Number(rules.highEvRankPenaltyProbMaxExclusive);
  const penalize =
    lambda > 0 &&
    Number.isFinite(p) &&
    Number.isFinite(minEv) &&
    Number.isFinite(pMin) &&
    Number.isFinite(pMax) &&
    ev >= minEv &&
    p >= pMin &&
    p < pMax;
  let score = penalize ? ev - lambda : ev;
  const earlyLambda = Number(rules.earlyExitsSoftPenaltyLambda) || 0;
  if (earlyLambda > 0 && pickEarlyExitsHigher) {
    score -= earlyLambda;
  }
  return score;
}

export function compareMlbMoneylineDailyRank(a, b, rules = MLB_MONEYLINE_RECOMMENDATION_RULES) {
  const scoreA = scoreMlbMoneylineDailyRank(a, rules);
  const scoreB = scoreMlbMoneylineDailyRank(b, rules);
  if (scoreB !== scoreA) return scoreB - scoreA;
  const marginA = Number(a?.expectedRunMargin) || 0;
  const marginB = Number(b?.expectedRunMargin) || 0;
  if (marginB !== marginA) return marginB - marginA;
  return 0;
}

const FALLBACK = {
  runs: 4.4,
  era: 4.3,
  whip: 1.3,
  kMinusBb9: 5.5,
  k9: 8.5,
  bb9: 3.0,
  hr9: 1.2,
  fip: 4.2,
  restDays: 4,
  pitches: 90,
  bullpenPitchesLast3: 120,
  obp: 0.32,
  slg: 0.41,
  kRate: 0.23,
  bbRate: 0.085,
  opsAllowed: 0.72,
  offenseOps: 0.72,
};
const FIP_CONSTANT = 3.2;
const MAX_RUNS = 24;

function finite(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function shrinkRate(value, sampleSize, priorMean, priorSize) {
  const sample = Math.max(0, finite(sampleSize));
  const observed = finite(value, priorMean);
  return (observed * sample + priorMean * priorSize) /
    Math.max(1e-9, sample + priorSize);
}

/**
 * v4.6 凍結 sparseStart：GS∈[1,3] 且該先發所屬隊賽前 W+L≥15。
 * W+L 缺失時以 commence ≥ 當年 4/20 為代理。
 */
export function resolveMlbOpponentStarterSparseStart({
  gamesStarted,
  teamWins,
  teamLosses,
  commenceTime,
} = {}) {
  const gs = Number(gamesStarted);
  if (!Number.isFinite(gs) || gs < 1 || gs > 3) return 0;
  const wins = Number(teamWins);
  const losses = Number(teamLosses);
  if (Number.isFinite(wins) && Number.isFinite(losses)) {
    return wins + losses >= MLB_SPARSE_START_MIN_TEAM_GAMES ? 1 : 0;
  }
  const iso = String(commenceTime || '');
  const year = Number(iso.slice(0, 4));
  if (!Number.isFinite(year) || year < 2000) return 0;
  return iso.slice(0, 10) >= `${year}-04-20` ? 1 : 0;
}

export function resolveMlbOpponentStarterIdentityFlags(features, scoringSide) {
  const opponent = scoringSide === 'home' ? 'away' : 'home';
  const pitchers = features?.pitchers || {};
  const ilKey = opponent === 'home' ? 'homeIlReturn' : 'awayIlReturn';
  const ilReturn = pitchers[ilKey];
  const oppTeam = features?.[opponent] || {};
  const daysRaw = Number(ilReturn?.daysSinceLastIlExit);
  const daysSinceIlExit = Number.isFinite(daysRaw) && daysRaw >= 0
    ? clamp(daysRaw, 0, MLB_IL_DAYS_SINCE_EXIT_MISSING)
    : MLB_IL_DAYS_SINCE_EXIT_MISSING;
  const seasonGs = clamp(finite(pitchers?.[opponent]?.gamesStarted, 0), 0, 40);
  return {
    opponentStarterIsReturnFromIl: ilReturn?.isReturnPitcher ? 1 : 0,
    opponentStarterIsSparseStart: resolveMlbOpponentStarterSparseStart({
      gamesStarted: pitchers?.[opponent]?.gamesStarted,
      teamWins: oppTeam.wins,
      teamLosses: oppTeam.losses,
      commenceTime: features?.commenceTime,
    }),
    opponentStarterDaysSinceIlExit: daysSinceIlExit,
    opponentStarterSeasonGs: seasonGs,
  };
}

export function buildMlbExpectedRunsSideFeatures(features, side) {
  const opponent = side === 'home' ? 'away' : 'home';
  const team = features?.[side] || {};
  const oppTeam = features?.[opponent] || {};
  const pitcher = features?.pitchers?.[opponent] || null;
  const identityFlags = resolveMlbOpponentStarterIdentityFlags(features, side);
  const recentPitcher = features?.pitchers?.[
    opponent === 'home' ? 'homeRecent' : 'awayRecent'
  ] || null;
  const batting = features?.recentBoxscore?.[side]?.batting || null;
  const bullpen = features?.recentBoxscore?.[opponent]?.bullpen || null;
  const pitcherInnings = finite(pitcher?.inningsPitched);
  const pitcherStarts = finite(pitcher?.gamesStarted);
  const recentStarts = finite(recentPitcher?.startsObserved);
  const seasonExpectedInnings = pitcherStarts > 0
    ? clamp(pitcherInnings / pitcherStarts, 3, 7)
    : 5;
  const recentExpectedInnings = recentStarts > 0
    ? clamp(finite(recentPitcher?.recent3Innings) / recentStarts, 3, 7)
    : seasonExpectedInnings;
  const expectedInnings = shrinkRate(
    recentExpectedInnings,
    recentStarts,
    seasonExpectedInnings,
    3
  );
  const starterShare = expectedInnings / 9;
  const bullpenShare = 1 - starterShare;
  const starterEra = shrinkRate(
    pitcher?.era,
    pitcherInnings,
    FALLBACK.era,
    30
  );
  const starterWhip = shrinkRate(
    pitcher?.whip,
    pitcherInnings,
    FALLBACK.whip,
    30
  );
  const starterKMinusBb9 = shrinkRate(
    finite(pitcher?.strikeoutsPer9, FALLBACK.kMinusBb9 + 3) -
      finite(pitcher?.walksPer9, 3),
    pitcherInnings,
    FALLBACK.kMinusBb9,
    30
  );
  const recentInnings = finite(recentPitcher?.recent3Innings);
  const recentEra = shrinkRate(
    recentPitcher?.recent3Era,
    recentInnings,
    starterEra,
    18
  );
  const bullpenGames = finite(bullpen?.gamesObserved);
  const bullpenEra = shrinkRate(
    bullpen?.era,
    bullpenGames,
    FALLBACK.era,
    10
  );
  const bullpenWhip = shrinkRate(
    bullpen?.whip,
    bullpenGames,
    FALLBACK.whip,
    10
  );
  const starterHr9 = shrinkRate(
    pitcherInnings > 0 && pitcher?.homeRuns != null
      ? finite(pitcher.homeRuns) * 9 / pitcherInnings
      : null,
    pitcherInnings,
    FALLBACK.hr9,
    30
  );
  const starterK9 = shrinkRate(
    pitcher?.strikeoutsPer9,
    pitcherInnings,
    FALLBACK.k9,
    30
  );
  const starterBb9 = shrinkRate(
    pitcher?.walksPer9,
    pitcherInnings,
    FALLBACK.bb9,
    30
  );
  const starterFip = shrinkRate(
    (13 * starterHr9 + 3 * starterBb9 - 2 * starterK9) / 9 + FIP_CONSTANT,
    pitcherInnings,
    FALLBACK.fip,
    30
  );
  const recentKMinusBb9 = shrinkRate(
    finite(recentPitcher?.recent3K9, starterK9) -
      finite(recentPitcher?.recent3BB9, starterBb9),
    recentInnings,
    starterKMinusBb9,
    18
  );
  const bullpenHr9 = shrinkRate(
    bullpen?.hr9,
    bullpenGames,
    FALLBACK.hr9,
    10
  );
  const bullpenKMinusBb = shrinkRate(
    bullpen?.kMinusBbRate,
    bullpenGames,
    FALLBACK.kMinusBb9 / 38,
    10
  );
  const bullpenUsage = features?.bullpen?.[opponent] || null;
  const battingGames = finite(batting?.gamesObserved);
  const recentGames = finite(team.recentGames);
  const opponentRecentGames = finite(oppTeam.recentGames);
  const offenseRecentRpg = shrinkRate(
    team.recentRunsPerGame,
    recentGames,
    FALLBACK.runs,
    10
  );
  const platoonSide = features?.platoon?.[opponent] || null;
  const offensePlatoon = features?.platoon?.[side]?.offense || null;
  const starterHand =
    platoonSide?.pitchHand ||
    features?.pitchers?.[opponent === 'home' ? 'homeHand' : 'awayHand'] ||
    null;
  const starterOpsVsLhb = shrinkRate(
    platoonSide?.pitcher?.vsLhb?.ops,
    finite(platoonSide?.pitcher?.vsLhb?.battersFaced),
    FALLBACK.opsAllowed,
    120
  );
  const starterOpsVsRhb = shrinkRate(
    platoonSide?.pitcher?.vsRhb?.ops,
    finite(platoonSide?.pitcher?.vsRhb?.battersFaced),
    FALLBACK.opsAllowed,
    120
  );
  const offenseOpsVsHandRaw = starterHand === 'L'
    ? offensePlatoon?.vsLhp?.ops
    : starterHand === 'R'
      ? offensePlatoon?.vsRhp?.ops
      : null;
  const offenseOpsVsHandSample = starterHand === 'L'
    ? finite(offensePlatoon?.vsLhp?.plateAppearances)
    : starterHand === 'R'
      ? finite(offensePlatoon?.vsRhp?.plateAppearances)
      : 0;
  const weatherVector = buildMlbWeatherFeatureVector(
    features?.weather || getCachedMlbGameWeather({
      gameId: features?.gameId,
      commenceTime: features?.commenceTime,
      venueName: features?.venueName,
      homeTeam: features?.homeTeam,
    })
  );
  return {
    isHome: side === 'home' ? 1 : 0,
    parkFactor: finite(
      features?.parkFactor,
      resolveMlbParkFactor({
        venueName: features?.venueName,
        homeTeam: features?.homeTeam,
      })
    ),
    offenseRecentRpg,
    offenseObp: shrinkRate(batting?.obp, battingGames, FALLBACK.obp, 10),
    offenseSlg: shrinkRate(batting?.slg, battingGames, FALLBACK.slg, 10),
    offenseKMinusBbRate:
      shrinkRate(batting?.bbRate, battingGames, FALLBACK.bbRate, 10) -
      shrinkRate(batting?.kRate, battingGames, FALLBACK.kRate, 10),
    opponentRecentRaRpg: shrinkRate(
      oppTeam.recentRunsAllowedPerGame,
      opponentRecentGames,
      FALLBACK.runs,
      10
    ),
    opponentStarterEraContribution:
      (starterEra - FALLBACK.era) * starterShare,
    opponentStarterWhipContribution:
      (starterWhip - FALLBACK.whip) * starterShare,
    opponentStarterKMinusBb9Contribution:
      (starterKMinusBb9 - FALLBACK.kMinusBb9) * starterShare,
    opponentStarterRecentEraContribution:
      (recentEra - starterEra) * starterShare,
    opponentStarterHr9Contribution:
      (starterHr9 - FALLBACK.hr9) * starterShare,
    opponentStarterFipContribution:
      (starterFip - FALLBACK.fip) * starterShare,
    opponentStarterRecentKMinusBbContribution:
      (recentKMinusBb9 - starterKMinusBb9) * starterShare,
    offenseVsStarterEraGap:
      (offenseRecentRpg - FALLBACK.runs) * (starterEra - FALLBACK.era),
    opponentStarterIsLefty: starterHand === 'L' ? 1 : 0,
    opponentStarterOpsVsLhb: starterOpsVsLhb,
    opponentStarterOpsVsRhb: starterOpsVsRhb,
    offenseOpsVsStarterHand: shrinkRate(
      offenseOpsVsHandRaw,
      offenseOpsVsHandSample,
      FALLBACK.offenseOps,
      200
    ),
    opponentBullpenEraContribution:
      (bullpenEra - FALLBACK.era) * bullpenShare,
    opponentBullpenWhipContribution:
      (bullpenWhip - FALLBACK.whip) * bullpenShare,
    opponentBullpenHr9Contribution:
      (bullpenHr9 - FALLBACK.hr9) * bullpenShare,
    opponentBullpenKMinusBbContribution:
      (bullpenKMinusBb - FALLBACK.kMinusBb9 / 38) * bullpenShare,
    opponentBullpenPitchesLast3: clamp(
      finite(bullpenUsage?.pitchesLast3, FALLBACK.bullpenPitchesLast3),
      40,
      320
    ),
    opponentStarterExpectedInnings: expectedInnings,
    opponentStarterRestDays: clamp(
      finite(recentPitcher?.restDays, FALLBACK.restDays),
      2,
      10
    ),
    opponentStarterIsReturnFromIl: identityFlags.opponentStarterIsReturnFromIl,
    opponentStarterIsSparseStart: identityFlags.opponentStarterIsSparseStart,
    opponentStarterDaysSinceIlExit: identityFlags.opponentStarterDaysSinceIlExit,
    opponentStarterSeasonGs: identityFlags.opponentStarterSeasonGs,
    gameTemperatureC: weatherVector.gameTemperatureC,
    gameWindSpeedKph: weatherVector.gameWindSpeedKph,
    gamePrecipProbability: weatherVector.gamePrecipProbability,
  };
}

export function buildMlbExpectedRunsExamples(gameRows) {
  return gameRows.flatMap((row) => [
    {
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      side: 'home',
      targetRuns: Number(row.homeScore),
      vector: buildMlbExpectedRunsSideFeatures(row.features, 'home'),
    },
    {
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      side: 'away',
      targetRuns: Number(row.awayScore),
      vector: buildMlbExpectedRunsSideFeatures(row.features, 'away'),
    },
  ]).filter((row) =>
    Number.isFinite(row.targetRuns) && row.targetRuns >= 0 &&
    MLB_EXPECTED_RUNS_FEATURE_KEYS.every((key) => Number.isFinite(row.vector[key]))
  );
}

function vectorStats(examples, featureKeys) {
  const means = {};
  const scales = {};
  for (const key of featureKeys) {
    const values = examples.map((row) => row.vector[key]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(1, values.length - 1);
    means[key] = mean;
    scales[key] = Math.max(0.01, Math.sqrt(variance));
  }
  return { means, scales };
}

function standardizedValue(model, vector, key) {
  return (finite(vector?.[key]) - finite(model.means?.[key])) /
    Math.max(0.01, finite(model.scales?.[key], 1));
}

function featureGroup(key) {
  if (key === 'isHome' || key === 'parkFactor') return 'venue';
  if (MLB_EXPECTED_RUNS_WEATHER_FEATURE_KEYS.includes(key)) return 'weather';
  if (key === 'offenseVsStarterEraGap') return 'matchup';
  if (MLB_EXPECTED_RUNS_PLATOON_FEATURE_KEYS.includes(key)) return 'platoon';
  if (
    key === 'offenseRecentRpg' ||
    MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS.includes(key)
  ) return 'offense';
  if (key === 'opponentRecentRaRpg') return 'opponentRunPrevention';
  if (
    MLB_EXPECTED_RUNS_BULLPEN_FEATURE_KEYS.includes(key) ||
    MLB_EXPECTED_RUNS_BULLPEN_STRENGTH_FEATURE_KEYS.includes(key)
  ) {
    return 'opponentBullpen';
  }
  return 'opponentStarter';
}

export function explainMlbExpectedRunsMean(model, vector) {
  const featureKeys = model?.featureKeys || MLB_EXPECTED_RUNS_FEATURE_KEYS;
  const intercept = finite(model?.intercept, Math.log(FALLBACK.runs));
  const contributions = featureKeys.map((key) => {
    const zScore = standardizedValue(model, vector, key);
    const linearContribution = finite(model?.weights?.[key]) * zScore;
    return {
      key,
      group: featureGroup(key),
      value: finite(vector?.[key]),
      trainingMean: finite(model?.means?.[key]),
      zScore,
      linearContribution,
      multiplier: Math.exp(linearContribution),
    };
  });
  const linearPredictor = intercept + contributions.reduce(
    (sum, contribution) => sum + contribution.linearContribution,
    0
  );
  const expectedRuns = clamp(Math.exp(clamp(linearPredictor, -2, 3)), 0.5, 12);
  const groups = Object.fromEntries(
    [...new Set(contributions.map((entry) => entry.group))].map((group) => {
      const linearContribution = contributions
        .filter((entry) => entry.group === group)
        .reduce((sum, entry) => sum + entry.linearContribution, 0);
      return [group, {
        linearContribution,
        multiplier: Math.exp(linearContribution),
        runImpact: expectedRuns -
          clamp(Math.exp(clamp(linearPredictor - linearContribution, -2, 3)), 0.5, 12),
      }];
    })
  );
  const outOfDistributionFeatures = contributions
    .filter((entry) => Math.abs(entry.zScore) > 3.5)
    .map((entry) => ({ key: entry.key, zScore: entry.zScore }));
  return {
    expectedRuns,
    baselineExpectedRuns: clamp(Math.exp(intercept), 0.5, 12),
    linearPredictor,
    groups,
    contributions,
    dataQuality: {
      maximumAbsoluteZScore: contributions.reduce(
        (maximum, entry) => Math.max(maximum, Math.abs(entry.zScore)),
        0
      ),
      outOfDistribution: outOfDistributionFeatures.length > 0,
      outOfDistributionFeatures,
    },
  };
}

export function predictMlbExpectedRunsMean(model, vector) {
  return explainMlbExpectedRunsMean(model, vector).expectedRuns;
}

function estimateDispersion(examples, model) {
  let numerator = 0;
  let denominator = 0;
  for (const row of examples) {
    const mean = predictMlbExpectedRunsMean(model, row.vector);
    numerator += (row.targetRuns - mean) ** 2 - mean;
    denominator += mean ** 2;
  }
  const alpha = clamp(numerator / Math.max(1e-9, denominator), 0.02, 1);
  return 1 / alpha;
}

export function fitMlbExpectedRunsModel(examples, {
  epochs = 1200,
  learningRate = 0.015,
  l2 = 0.03,
  featureKeys = MLB_EXPECTED_RUNS_FEATURE_KEYS,
} = {}) {
  if (!examples?.length || examples.length < 200) {
    throw new Error('mlb_expected_runs_examples_insufficient');
  }
  const { means, scales } = vectorStats(examples, featureKeys);
  const targetMean = examples.reduce((sum, row) => sum + row.targetRuns, 0) /
    examples.length;
  const model = {
    modelVersion: MLB_EXPECTED_RUNS_MODEL_VERSION,
    featureKeys,
    means,
    scales,
    intercept: Math.log(Math.max(0.5, targetMean)),
    weights: Object.fromEntries(featureKeys.map((key) => [key, 0])),
    dispersion: 8,
  };
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let interceptGradient = 0;
    const gradients = Object.fromEntries(
      featureKeys.map((key) => [key, 0])
    );
    for (const row of examples) {
      const mean = predictMlbExpectedRunsMean(model, row.vector);
      const error = mean - row.targetRuns;
      interceptGradient += error;
      for (const key of featureKeys) {
        gradients[key] += error * standardizedValue(model, row.vector, key);
      }
    }
    model.intercept -= learningRate * interceptGradient / examples.length;
    for (const key of featureKeys) {
      model.weights[key] -= learningRate * (
        gradients[key] / examples.length + l2 * model.weights[key]
      );
    }
  }
  model.dispersion = estimateDispersion(examples, model);
  model.trainSamples = examples.length;
  return model;
}

function logGamma(value) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) -
      logGamma(1 - value);
  }
  let x = 0.9999999999998099;
  const z = value - 1;
  coefficients.forEach((coefficient, index) => {
    x += coefficient / (z + index + 1);
  });
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function negativeBinomialPmf(runs, mean, dispersion) {
  if (!Number.isInteger(runs) || runs < 0 || mean <= 0 || dispersion <= 0) return 0;
  const size = dispersion;
  const logProbability =
    logGamma(runs + size) - logGamma(size) - logGamma(runs + 1) +
    size * Math.log(size / (size + mean)) +
    runs * Math.log(mean / (size + mean));
  return Math.exp(logProbability);
}

export function buildMlbScoreDistribution({
  homeMean,
  awayMean,
  homeDispersion,
  awayDispersion,
  maxRuns = MAX_RUNS,
}) {
  const cells = [];
  let mass = 0;
  for (let home = 0; home <= maxRuns; home += 1) {
    for (let away = 0; away <= maxRuns; away += 1) {
      const probability =
        negativeBinomialPmf(home, homeMean, homeDispersion) *
        negativeBinomialPmf(away, awayMean, awayDispersion);
      cells.push({ home, away, probability });
      mass += probability;
    }
  }
  return cells.map((cell) => ({ ...cell, probability: cell.probability / mass }));
}

export function deriveMlbScoreMarkets(distribution, {
  totalLine = 8.5,
  homeSpread = -1.5,
  extraInningsHomeProbability = 0.5,
} = {}) {
  let homeWin = 0;
  let awayWin = 0;
  let tie = 0;
  let over = 0;
  let under = 0;
  let totalPush = 0;
  let homeCover = 0;
  let homeSpreadLoss = 0;
  let spreadPush = 0;
  for (const cell of distribution) {
    if (cell.home > cell.away) homeWin += cell.probability;
    else if (cell.away > cell.home) awayWin += cell.probability;
    else tie += cell.probability;
    const total = cell.home + cell.away;
    if (total > totalLine) over += cell.probability;
    else if (total < totalLine) under += cell.probability;
    else totalPush += cell.probability;
    const adjustedMargin = cell.home - cell.away + homeSpread;
    if (adjustedMargin > 0) homeCover += cell.probability;
    else if (adjustedMargin < 0) homeSpreadLoss += cell.probability;
    else spreadPush += cell.probability;
  }
  return {
    homeWinProbability: homeWin + tie * extraInningsHomeProbability,
    awayWinProbability: awayWin + tie * (1 - extraInningsHomeProbability),
    regulationTieProbability: tie,
    total: {
      line: totalLine,
      overProbability: over,
      underProbability: under,
      pushProbability: totalPush,
    },
    homeSpread: {
      line: homeSpread,
      coverProbability: homeCover,
      lossProbability: homeSpreadLoss,
      pushProbability: spreadPush,
    },
  };
}

export function applyProbabilityTemperature(probability, temperature = 1) {
  const p = clamp(finite(probability, 0.5), 0.001, 0.999);
  const t = Math.max(0.2, finite(temperature, 1));
  if (Math.abs(t - 1) < 1e-9) return p;
  const logit = Math.log(p / (1 - p));
  return 1 / (1 + Math.exp(-logit / t));
}

export function calibrateMlbScoreMarkets(markets, moneylineTemperature = 1) {
  if (!markets || Math.abs(finite(moneylineTemperature, 1) - 1) < 1e-9) {
    return markets;
  }
  const home = applyProbabilityTemperature(
    markets.homeWinProbability,
    moneylineTemperature
  );
  return {
    ...markets,
    homeWinProbability: home,
    awayWinProbability: 1 - home,
    moneylineTemperature,
  };
}

export function predictMlbGameRuns(model, features, marketOptions = {}) {
  // 凍結：PrematchTruth／正式研究輸出唯一允許的預測入口。
  const homeVector = buildMlbExpectedRunsSideFeatures(features, 'home');
  const awayVector = buildMlbExpectedRunsSideFeatures(features, 'away');
  const homeExplanation = explainMlbExpectedRunsMean(model, homeVector);
  const awayExplanation = explainMlbExpectedRunsMean(model, awayVector);
  const homeMean = homeExplanation.expectedRuns;
  const awayMean = awayExplanation.expectedRuns;
  const distribution = buildMlbScoreDistribution({
    homeMean,
    awayMean,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
  });
  const rawMarkets = deriveMlbScoreMarkets(distribution, marketOptions);
  return {
    homeExpectedRuns: homeMean,
    awayExpectedRuns: awayMean,
    expectedTotal: homeMean + awayMean,
    dispersion: model.dispersion,
    homeDispersion: model.dispersion,
    awayDispersion: model.dispersion,
    moneylineTemperature: finite(model.moneylineTemperature, 1),
    featureContract: model.featureKeys,
    explanation: {
      home: homeExplanation,
      away: awayExplanation,
    },
    dataQuality: {
      outOfDistribution:
        homeExplanation.dataQuality.outOfDistribution ||
        awayExplanation.dataQuality.outOfDistribution,
      maximumAbsoluteZScore: Math.max(
        homeExplanation.dataQuality.maximumAbsoluteZScore,
        awayExplanation.dataQuality.maximumAbsoluteZScore
      ),
    },
    markets: calibrateMlbScoreMarkets(
      rawMarkets,
      model.moneylineTemperature
    ),
  };
}

/**
 * 在既有預測上附加型態市場路由（不改均值）。
 * 正式路徑可只用這個：均值仍用 v4.5，盤口選擇改走大小球優先。
 */
export function attachMlbRegimeMarketPlan(prediction, features, marketOptions = {}) {
  if (!prediction) return null;
  const marketPlan = resolveMlbRegimeMarketPlan({ features });
  const totalLine = Number(marketOptions.totalLine ?? prediction.markets?.total?.line ?? 8.5);
  const totalsDecision = buildMlbRegimeTotalsLeanDecision({
    marketPlan,
    expectedTotal: prediction.expectedTotal,
    totalLine,
    overProbability: prediction.markets?.total?.overProbability,
    underProbability: prediction.markets?.total?.underProbability,
  });
  return {
    ...prediction,
    marketPlan,
    totalsDecision,
  };
}

/**
 * Phase 2：soft 方差調整 + 市場路由（研究用 audit only）。
 * 凍結：禁止接入 MlbPrematchTruthPipeline 正式路徑。
 * 崩盤場以識別／方差為主，不追求精確總分。
 */
export function predictMlbGameRunsWithRegime(model, features, marketOptions = {}) {
  const base = predictMlbGameRuns(model, features, marketOptions);
  const signals = buildPregameRegimeSignals(features);
  const scored = scoreGameRegimeFromPregame(signals);
  const adjusted = applySoftRegimeAdjustment({
    homeMean: base.homeExpectedRuns,
    awayMean: base.awayExpectedRuns,
    baseDispersion: model.dispersion,
    signals,
    scored,
  });
  const distribution = buildMlbScoreDistribution({
    homeMean: adjusted.homeMean,
    awayMean: adjusted.awayMean,
    homeDispersion: adjusted.homeDispersion,
    awayDispersion: adjusted.awayDispersion,
  });
  const rawMarkets = deriveMlbScoreMarkets(distribution, marketOptions);
  const prediction = {
    ...base,
    homeExpectedRuns: adjusted.homeMean,
    awayExpectedRuns: adjusted.awayMean,
    expectedTotal: adjusted.homeMean + adjusted.awayMean,
    homeDispersion: adjusted.homeDispersion,
    awayDispersion: adjusted.awayDispersion,
    dispersion: (adjusted.homeDispersion + adjusted.awayDispersion) / 2,
    regime: {
      version: 'mlb-game-regime-phase2-v1',
      predicted: scored.predicted,
      duelScore: scored.duelScore,
      blowupScore: scored.blowupScore,
      strengths: adjusted.strengths,
      notes: adjusted.notes,
      scorePursuitOnBlowup: false,
      signals,
    },
    markets: calibrateMlbScoreMarkets(
      rawMarkets,
      model.moneylineTemperature
    ),
  };
  return attachMlbRegimeMarketPlan(prediction, features, marketOptions);
}

export function classifyMlbMoneylineCandidate({
  prediction,
  market,
  modelStatus = 'research_scored',
  rules = MLB_MONEYLINE_RECOMMENDATION_RULES,
  regimeSignals = null,
  pitcherIdentity = null,
  features = null,
} = {}) {
  if (!prediction?.markets || !market?.homeOdds || !market?.awayOdds) {
    return { tier: 'blocked', reasons: ['prediction_or_market_missing'] };
  }
  const pickHome = prediction.homeExpectedRuns >= prediction.awayExpectedRuns;
  let modelProbability = pickHome
    ? prediction.markets.homeWinProbability
    : prediction.markets.awayWinProbability;
  const marketProbability = pickHome ? market.homeProb : market.awayProb;
  const homeOdds = Number(market.homeOdds);
  const awayOdds = Number(market.awayOdds);
  const odds = pickHome ? homeOdds : awayOdds;
  const expectedRunMargin = Math.abs(
    prediction.homeExpectedRuns - prediction.awayExpectedRuns
  );
  const homeWinPct = Number(features?.home?.homeWinPct);
  const modelProbabilityRaw = modelProbability;
  modelProbability = applyLockedBToxicShrinkInline(modelProbability, odds, {
    pickHome,
    homeWinPct: Number.isFinite(homeWinPct) ? homeWinPct : null,
  });
  const toxicShrinkApplied = modelProbability !== modelProbabilityRaw;
  const edge = modelProbability - marketProbability;
  const expectedValue = modelProbability * odds - 1;
  const maximumAbsoluteZScore = finite(
    prediction.dataQuality?.maximumAbsoluteZScore,
    Infinity
  );
  const eitherSideTooShort =
    rules.minimumEitherSideOdds != null &&
    (homeOdds < rules.minimumEitherSideOdds ||
      awayOdds < rules.minimumEitherSideOdds);
  const rawBookCount =
    market.h2hBookCount ?? market.bookmakerCount ?? market.bookCount;
  const hasBookCount =
    rawBookCount != null && Number.isFinite(Number(rawBookCount));
  const h2hBookCount = hasBookCount ? Number(rawBookCount) : null;
  const tooFewBookmakers =
    rules.minimumH2hBookmakers != null &&
    hasBookCount &&
    h2hBookCount < rules.minimumH2hBookmakers;

  let pickEarlyExitsHigher = false;
  const softEarlyLambda = Number(rules.earlyExitsSoftPenaltyLambda) || 0;
  if (
    (rules.requirePickEarlyExitsNotHigher || softEarlyLambda > 0) &&
    regimeSignals
  ) {
    const homeEarly = Number(regimeSignals.homeEarlyExitsLast3) || 0;
    const awayEarly = Number(regimeSignals.awayEarlyExitsLast3) || 0;
    const pickEarly = pickHome ? homeEarly : awayEarly;
    const oppEarly = pickHome ? awayEarly : homeEarly;
    pickEarlyExitsHigher = pickEarly > oppEarly;
  }

  const resolvedIdentity = pitcherIdentity || {
    homeId:
      features?.pitchers?.homeIdentity?.id ??
      features?.pitchers?.home?.id ??
      null,
    awayId:
      features?.pitchers?.awayIdentity?.id ??
      features?.pitchers?.away?.id ??
      null,
  };
  const homePitcherId = resolvedIdentity.homeId ?? null;
  const awayPitcherId = resolvedIdentity.awayId ?? null;
  const bothPitcherIdentities =
    homePitcherId != null &&
    homePitcherId !== '' &&
    awayPitcherId != null &&
    awayPitcherId !== '';

  const reasons = [
    ...(modelStatus === 'research_scored'
      ? []
      : ['strict_pit_starter_required']),
    ...(modelProbability >= rules.minimumModelProbability
      ? []
      : ['model_probability_below_threshold']),
    ...(expectedRunMargin >= rules.minimumExpectedRunMargin
      ? []
      : ['expected_run_margin_below_threshold']),
    ...(rules.minimumExpectedValue == null ||
    expectedValue >= rules.minimumExpectedValue
      ? []
      : ['expected_value_below_threshold']),
    ...(rules.minimumPickOdds == null || odds >= rules.minimumPickOdds
      ? []
      : ['pick_odds_below_minimum']),
    ...(rules.maximumPickOdds == null || odds <= rules.maximumPickOdds
      ? []
      : ['pick_odds_above_maximum']),
    ...(eitherSideTooShort ? ['moneyline_either_side_odds_too_short'] : []),
    ...(tooFewBookmakers ? ['h2h_bookmakers_below_minimum'] : []),
    ...(rules.requirePickEarlyExitsNotHigher && pickEarlyExitsHigher
      ? ['pick_early_exits_higher_than_opponent']
      : []),
    ...(rules.requireBothPitcherIdentities && !bothPitcherIdentities
      ? ['pitcher_identity_incomplete']
      : []),
    ...(maximumAbsoluteZScore <= rules.maximumAbsoluteZScore
      ? []
      : ['feature_out_of_distribution']),
  ];
  const common = {
    side: pickHome ? 'home' : 'away',
    modelProbability,
    modelProbabilityRaw: toxicShrinkApplied ? modelProbabilityRaw : undefined,
    toxicShrinkApplied: toxicShrinkApplied || undefined,
    marketProbability,
    odds,
    edge,
    expectedValue,
    expectedRunMargin,
    maximumAbsoluteZScore,
    homePitcherId,
    awayPitcherId,
    bothPitcherIdentities,
    pickEarlyExitsHigher,
    reasons,
  };
  if (!reasons.length) return { tier: 'recommendation', ...common };
  if (
    modelStatus === 'research_scored' &&
    edge > 0 &&
    expectedValue > 0 &&
    maximumAbsoluteZScore <= rules.maximumAbsoluteZScore
  ) {
    return { tier: 'value_watch', ...common };
  }
  return { tier: 'blocked', ...common };
}

function loadRows() {
  return db.prepare(`
    SELECT f.game_id, f.commence_time, f.features_json,
           g.home_team, g.away_team, g.home_score, g.away_score
    FROM mlb_historical_feature_rows f
    JOIN games g ON g.id = f.game_id
    WHERE f.feature_version = ?
      AND g.completed = 1
      AND g.home_score IS NOT NULL
      AND g.away_score IS NOT NULL
      AND datetime(f.commence_time) >= datetime('2025-01-01')
    ORDER BY datetime(f.commence_time), f.game_id
  `).all(MLB_BASELINE_FEATURE_VERSION).flatMap((row) => {
    try {
      const features = JSON.parse(row.features_json);
      features.gameId = row.game_id;
      features.commenceTime = row.commence_time;
      features.homeTeam = row.home_team;
      features.awayTeam = row.away_team;
      features.parkFactor = resolveMlbParkFactor({
        venueName: features.venueName,
        homeTeam: row.home_team,
      });
      features.weather = getCachedMlbGameWeather({
        gameId: row.game_id,
        commenceTime: row.commence_time,
        venueName: features.venueName,
        homeTeam: row.home_team,
      });
      return [{
        gameId: row.game_id,
        commenceTime: row.commence_time,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        homeScore: Number(row.home_score),
        awayScore: Number(row.away_score),
        features,
      }];
    } catch {
      return [];
    }
  });
}

function probabilityMetrics(points) {
  if (!points.length) return { samples: 0, brier: null, logLoss: null, accuracy: null };
  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  for (const point of points) {
    const p = clamp(point.p, 0.001, 0.999);
    brier += (p - point.y) ** 2;
    logLoss -= point.y * Math.log(p) + (1 - point.y) * Math.log(1 - p);
    if ((p >= 0.5 ? 1 : 0) === point.y) correct += 1;
  }
  return {
    samples: points.length,
    brier: brier / points.length,
    logLoss: logLoss / points.length,
    accuracy: correct / points.length,
  };
}

function confidenceMetrics(points) {
  return Object.fromEntries([0.5, 0.55, 0.6, 0.65, 0.7].map((threshold) => {
    const selected = points.filter((point) =>
      Math.max(point.p, 1 - point.p) >= threshold
    );
    const wins = selected.filter((point) =>
      (point.p >= 0.5 ? 1 : 0) === point.y
    ).length;
    return [`${Math.round(threshold * 100)}%+`, {
      samples: selected.length,
      wins,
      accuracy: selected.length ? wins / selected.length : null,
    }];
  }));
}

function marketProbability(row, key) {
  const pit = resolvePitOdds(row.gameId, row.commenceTime);
  if (!pit.ok) return null;
  let best = null;
  let h2hBookCount = 0;
  for (const book of pit.bookmakers) {
    const market = book.markets?.find((entry) => entry.key === key);
    if (!market) continue;
    if (key === 'h2h') {
      const home = market.outcomes?.find((outcome) => outcome.name === row.homeTeam);
      const away = market.outcomes?.find((outcome) => outcome.name === row.awayTeam);
      if (!home?.price || !away?.price) continue;
      h2hBookCount += 1;
      const fair = removeVig(
        decimalToImpliedProb(home.price),
        decimalToImpliedProb(away.price)
      );
      const vig = 1 / home.price + 1 / away.price;
      if (!best || vig < best.vig) {
        best = {
          probability: fair.fairA,
          homeOdds: Number(home.price),
          awayOdds: Number(away.price),
          vig,
        };
      }
    } else if (key === 'totals') {
      for (const over of market.outcomes || []) {
        if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
        const under = market.outcomes.find((outcome) =>
          outcome.name === 'Under' && Number(outcome.point) === Number(over.point)
        );
        if (!over.price || !under?.price) continue;
        const fair = removeVig(
          decimalToImpliedProb(over.price),
          decimalToImpliedProb(under.price)
        );
        const vig = 1 / over.price + 1 / under.price;
        if (!best || vig < best.vig) {
          best = { probability: fair.fairA, line: Number(over.point), vig };
        }
      }
    }
  }
  if (!best) return null;
  if (key === 'h2h') return { ...best, h2hBookCount };
  return best;
}

function summarizeMoneylineBets(bets) {
  if (!bets.length) {
    return {
      samples: 0,
      wins: 0,
      winRate: null,
      profitUnits: null,
      roi: null,
      roi95: null,
      averageOdds: null,
      averageEdge: null,
      averageModelProbability: null,
      averageExpectedRunMargin: null,
    };
  }
  const wins = bets.filter((bet) => bet.won).length;
  const profits = bets.map((bet) => (bet.won ? bet.odds - 1 : -1));
  const profitUnits = profits.reduce((sum, profit) => sum + profit, 0);
  const roi = profitUnits / bets.length;
  const variance = profits.reduce(
    (sum, profit) => sum + (profit - roi) ** 2,
    0
  ) / Math.max(1, bets.length - 1);
  const margin95 = 1.96 * Math.sqrt(variance / bets.length);
  return {
    samples: bets.length,
    wins,
    winRate: wins / bets.length,
    profitUnits,
    roi,
    roi95: [roi - margin95, roi + margin95],
    averageOdds: bets.reduce((sum, bet) => sum + bet.odds, 0) / bets.length,
    averageEdge: bets.reduce((sum, bet) => sum + bet.edge, 0) / bets.length,
    averageModelProbability:
      bets.reduce((sum, bet) => sum + bet.modelProbability, 0) / bets.length,
    averageExpectedRunMargin:
      bets.reduce((sum, bet) => sum + finite(bet.expectedRunMargin), 0) /
      bets.length,
  };
}

function moneylineBetDiagnostics(bets) {
  const positiveEv = bets.filter((bet) => bet.expectedValue > 0);
  const edgeThresholds = [0, 0.02, 0.03, 0.05, 0.08];
  const confidenceThresholds = [0.55, 0.6, 0.65];
  const oddsBands = [
    { key: '1.30-1.60', min: 1.3, max: 1.6 },
    { key: '1.60-1.80', min: 1.6, max: 1.8 },
    { key: '1.80-2.00', min: 1.8, max: 2 },
    { key: '2.00-2.30', min: 2, max: 2.3 },
    { key: '2.30+', min: 2.3, max: Infinity },
  ];
  const months = [...new Set(positiveEv.map((bet) => bet.month))].sort();
  return {
    compared: bets.length,
    positiveEv: summarizeMoneylineBets(positiveEv),
    byEdge: Object.fromEntries(edgeThresholds.map((threshold) => [
      `${Math.round(threshold * 100)}%+`,
      summarizeMoneylineBets(
        positiveEv.filter((bet) => bet.edge >= threshold)
      ),
    ])),
    byConfidence: Object.fromEntries(confidenceThresholds.map((threshold) => [
      `${Math.round(threshold * 100)}%+`,
      summarizeMoneylineBets(
        positiveEv.filter((bet) => bet.modelProbability >= threshold)
      ),
    ])),
    byOdds: Object.fromEntries(oddsBands.map((band) => [
      band.key,
      summarizeMoneylineBets(
        positiveEv.filter((bet) => bet.odds >= band.min && bet.odds < band.max)
      ),
    ])),
    byMonth: Object.fromEntries(months.map((month) => {
      const monthly = positiveEv.filter((bet) => bet.month === month);
      return [month, {
        all: summarizeMoneylineBets(monthly),
        '55%+': summarizeMoneylineBets(
          monthly.filter((bet) => bet.modelProbability >= 0.55)
        ),
        '60%+': summarizeMoneylineBets(
          monthly.filter((bet) => bet.modelProbability >= 0.6)
        ),
      }];
    })),
  };
}

function scoreMetrics(rows, model, { modelForRow = null } = {}) {
  let homeAbsolute = 0;
  let awayAbsolute = 0;
  let totalAbsolute = 0;
  let squared = 0;
  const winPoints = [];
  const pitModelWinPoints = [];
  const marketWinPoints = [];
  const expectedRunsSideBets = [];
  const edgePickPositiveEvBets = [];
  const strictRecommendationBets = [];
  const totalPoints = [];
  const marketTotalPoints = [];
  for (const row of rows) {
    const activeModel = modelForRow?.(row) || model;
    const prediction = predictMlbGameRuns(activeModel, row.features);
    homeAbsolute += Math.abs(prediction.homeExpectedRuns - row.homeScore);
    awayAbsolute += Math.abs(prediction.awayExpectedRuns - row.awayScore);
    totalAbsolute += Math.abs(prediction.expectedTotal - row.homeScore - row.awayScore);
    squared += (prediction.homeExpectedRuns - row.homeScore) ** 2 +
      (prediction.awayExpectedRuns - row.awayScore) ** 2;
    const homeWon = row.homeScore > row.awayScore ? 1 : 0;
    winPoints.push({ p: prediction.markets.homeWinProbability, y: homeWon });
    const h2h = marketProbability(row, 'h2h');
    if (h2h) {
      pitModelWinPoints.push({
        p: prediction.markets.homeWinProbability,
        y: homeWon,
      });
      marketWinPoints.push({ p: h2h.probability, y: homeWon });
      const pickHomeByRuns =
        prediction.homeExpectedRuns >= prediction.awayExpectedRuns;
      const modelProbability = pickHomeByRuns
        ? prediction.markets.homeWinProbability
        : prediction.markets.awayWinProbability;
      const marketFairProbability = pickHomeByRuns
        ? h2h.probability
        : 1 - h2h.probability;
      const odds = pickHomeByRuns ? h2h.homeOdds : h2h.awayOdds;
      expectedRunsSideBets.push({
        side: pickHomeByRuns ? 'home' : 'away',
        won: pickHomeByRuns ? homeWon === 1 : homeWon === 0,
        odds,
        modelProbability,
        marketFairProbability,
        edge: modelProbability - marketFairProbability,
        expectedValue: modelProbability * odds - 1,
        expectedRunMargin: Math.abs(
          prediction.homeExpectedRuns - prediction.awayExpectedRuns
        ),
        month: String(row.commenceTime).slice(0, 7),
      });
      const homeEdge = prediction.markets.homeWinProbability - h2h.probability;
      const pickHomeByEdge = homeEdge >= 0;
      const edgeModelProbability = pickHomeByEdge
        ? prediction.markets.homeWinProbability
        : prediction.markets.awayWinProbability;
      const edgeMarketFair = pickHomeByEdge
        ? h2h.probability
        : 1 - h2h.probability;
      const edgeOdds = pickHomeByEdge ? h2h.homeOdds : h2h.awayOdds;
      const edgeExpectedValue = edgeModelProbability * edgeOdds - 1;
      if (edgeExpectedValue > 0) {
        edgePickPositiveEvBets.push({
          side: pickHomeByEdge ? 'home' : 'away',
          won: pickHomeByEdge ? homeWon === 1 : homeWon === 0,
          odds: edgeOdds,
          modelProbability: edgeModelProbability,
          marketFairProbability: edgeMarketFair,
          edge: edgeModelProbability - edgeMarketFair,
          expectedValue: edgeExpectedValue,
          expectedRunMargin: Math.abs(
            prediction.homeExpectedRuns - prediction.awayExpectedRuns
          ),
          month: String(row.commenceTime).slice(0, 7),
        });
      }
      const candidate = classifyMlbMoneylineCandidate({
        prediction,
        market: {
          homeOdds: h2h.homeOdds,
          awayOdds: h2h.awayOdds,
          homeProb: h2h.probability,
          awayProb: 1 - h2h.probability,
          h2hBookCount: h2h.h2hBookCount,
        },
      });
      if (candidate.tier === 'recommendation') {
        strictRecommendationBets.push({
          ...candidate,
          won: candidate.side === 'home' ? homeWon === 1 : homeWon === 0,
          month: String(row.commenceTime).slice(0, 7),
        });
      }
    }
    const totals = marketProbability(row, 'totals');
    if (totals && row.homeScore + row.awayScore !== totals.line) {
      const markets = predictMlbGameRuns(activeModel, row.features, {
        totalLine: totals.line,
      }).markets;
      const decisive = 1 - markets.total.pushProbability;
      totalPoints.push({
        p: markets.total.overProbability / Math.max(1e-9, decisive),
        y: row.homeScore + row.awayScore > totals.line ? 1 : 0,
      });
      marketTotalPoints.push({
        p: totals.probability,
        y: row.homeScore + row.awayScore > totals.line ? 1 : 0,
      });
    }
  }
  return {
    samples: rows.length,
    homeRunsMae: homeAbsolute / rows.length,
    awayRunsMae: awayAbsolute / rows.length,
    totalRunsMae: totalAbsolute / rows.length,
    sideRunsRmse: Math.sqrt(squared / (rows.length * 2)),
    moneyline: probabilityMetrics(winPoints),
    moneylineConfidence: confidenceMetrics(winPoints),
    pitModelMoneyline: probabilityMetrics(pitModelWinPoints),
    pitMarketMoneyline: probabilityMetrics(marketWinPoints),
    expectedRunsSideBets: summarizeMoneylineBets(expectedRunsSideBets),
    moneylineBetDiagnostics: moneylineBetDiagnostics(expectedRunsSideBets),
    edgePickPositiveEvHallucination:
      summarizeMoneylineBets(edgePickPositiveEvBets),
    strictMoneylineRecommendations: {
      summary: summarizeMoneylineBets(strictRecommendationBets),
      diagnostics: moneylineBetDiagnostics(strictRecommendationBets),
    },
    totals: probabilityMetrics(totalPoints),
    pitMarketTotals: probabilityMetrics(marketTotalPoints),
  };
}

function fitMoneylineTemperature(rows, model) {
  const rawPoints = [];
  for (const row of rows) {
    const prediction = predictMlbGameRuns(
      { ...model, moneylineTemperature: 1 },
      row.features
    );
    rawPoints.push({
      p: prediction.markets.homeWinProbability,
      y: row.homeScore > row.awayScore ? 1 : 0,
    });
  }
  if (rawPoints.length < 100) {
    return { temperature: 1, validationBrier: probabilityMetrics(rawPoints).brier };
  }
  let bestTemperature = 1;
  let bestBrier = Infinity;
  // 只允許 T>=1：把過度自信往 0.5 收；禁止 T<1 在 validation 上擬合出更尖的概率。
  for (const temperature of [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
    const calibrated = rawPoints.map((point) => ({
      p: applyProbabilityTemperature(point.p, temperature),
      y: point.y,
    }));
    const brier = probabilityMetrics(calibrated).brier;
    if (brier < bestBrier - 1e-9 ||
      (Math.abs(brier - bestBrier) <= 1e-9 && temperature < bestTemperature)) {
      bestBrier = brier;
      bestTemperature = temperature;
    }
  }
  return {
    temperature: bestTemperature,
    validationBrier: bestBrier,
    rawValidationBrier: probabilityMetrics(rawPoints).brier,
  };
}

function range(rows) {
  return {
    from: rows[0]?.commenceTime ?? null,
    to: rows.at(-1)?.commenceTime ?? null,
  };
}

function probableStarterIdentityCoverage(rows) {
  const covered = completeProbableStarterGameIds();
  const games = rows.length;
  const complete = rows.filter((row) => covered.has(row.gameId)).length;
  const featureRowPit = rows.filter((row) =>
    row.features?.pitchers?.identityMode === 'pit_probable'
  ).length;
  return {
    games,
    complete,
    rate: games ? complete / games : 0,
    featureRowPit,
    featureRowPitRate: games ? featureRowPit / games : 0,
  };
}

function completeProbableStarterGameIds() {
  return new Set(db.prepare(`
    SELECT DISTINCT game_id
    FROM mlb_probable_starter_snapshots
    WHERE status = 'complete'
      AND datetime(captured_at) < datetime(commence_time)
  `).all().map((row) => row.game_id));
}

function expectedRunsFeatureCandidates({ includeStarter }) {
  const base = [
    'isHome',
    'offenseRecentRpg',
    'opponentRecentRaRpg',
  ];
  const core = includeStarter ? MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS : base;
  const withPark = [...MLB_EXPECTED_RUNS_PARK_FEATURE_KEYS];
  const withBatting = [...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS];
  const withBullpen = [...MLB_EXPECTED_RUNS_BULLPEN_FEATURE_KEYS];
  const withStarterStrength = [...MLB_EXPECTED_RUNS_STARTER_STRENGTH_FEATURE_KEYS];
  const withBullpenStrength = [...MLB_EXPECTED_RUNS_BULLPEN_STRENGTH_FEATURE_KEYS];
  const withPitchingStack = [...withStarterStrength, ...withBullpenStrength];
  const withPlatoon = [...MLB_EXPECTED_RUNS_PLATOON_FEATURE_KEYS];
  // v4.5：加入免費 API 前季 platoon；天氣已驗證幾乎無助，不進消融。
  return [
    { key: 'core', featureKeys: core },
    {
      key: 'core_plus_batting',
      featureKeys: [...core, ...withBatting],
    },
    {
      key: 'core_plus_platoon',
      featureKeys: [...core, ...withPlatoon],
    },
    {
      key: 'core_plus_batting_platoon',
      featureKeys: [...core, ...withBatting, ...withPlatoon],
    },
    {
      key: 'core_plus_starter_strength',
      featureKeys: [...core, ...withStarterStrength],
    },
    {
      key: 'core_plus_bullpen_strength',
      featureKeys: [...core, ...withBullpen, ...withBullpenStrength],
    },
    {
      key: 'core_plus_pitching_stack',
      featureKeys: [...core, ...withPitchingStack, ...withBullpen],
    },
    {
      key: 'core_plus_batting_pitching_stack',
      featureKeys: [...core, ...withBatting, ...withPitchingStack, ...withBullpen],
    },
    {
      key: 'core_plus_batting_platoon_pitching',
      featureKeys: [
        ...core,
        ...withBatting,
        ...withPlatoon,
        ...withPitchingStack,
        ...withBullpen,
      ],
    },
    {
      key: 'core_plus_bullpen',
      featureKeys: [...core, ...withBullpen],
    },
    {
      key: 'core_plus_park',
      featureKeys: [...core, ...withPark],
    },
    {
      key: 'core_plus_batting_park',
      featureKeys: [...core, ...withBatting, ...withPark],
    },
    {
      key: 'core_plus_batting_bullpen',
      featureKeys: [...core, ...withBatting, ...withBullpen],
    },
    {
      key: 'core_plus_batting_bullpen_park',
      featureKeys: [...core, ...withBatting, ...withBullpen, ...withPark],
    },
  ];
}

function selectExpectedRunsFeatureSet(trainRows, validationRows, options) {
  const trainExamples = buildMlbExpectedRunsExamples(trainRows);
  const candidates = expectedRunsFeatureCandidates(options).map((candidate) => {
    const model = fitMlbExpectedRunsModel(trainExamples, {
      featureKeys: candidate.featureKeys,
    });
    return {
      ...candidate,
      model,
      metrics: scoreMetrics(validationRows, model),
    };
  });
  // 先用總分 MAE 過濾明顯變差者，再以獨贏 Brier 為主排序（命中／校準優先）。
  const bestTotalRunsMae = Math.min(
    ...candidates.map((candidate) => candidate.metrics.totalRunsMae)
  );
  const selected = candidates
    .filter((candidate) =>
      candidate.metrics.totalRunsMae <= bestTotalRunsMae + 0.02
    )
    .sort((a, b) =>
      a.metrics.moneyline.brier - b.metrics.moneyline.brier ||
      a.metrics.sideRunsRmse - b.metrics.sideRunsRmse ||
      a.metrics.totalRunsMae - b.metrics.totalRunsMae ||
      a.featureKeys.length - b.featureKeys.length
    )[0];
  candidates.sort((a, b) =>
    a.metrics.moneyline.brier - b.metrics.moneyline.brier ||
    a.metrics.totalRunsMae - b.metrics.totalRunsMae ||
    a.metrics.sideRunsRmse - b.metrics.sideRunsRmse
  );
  return {
    selected,
    candidates,
  };
}

export function runMlbExpectedRunsValidation({ persist = true } = {}) {
  const rows = loadRows();
  const bySeason = (season) => rows.filter((row) =>
    String(row.commenceTime).startsWith(String(season))
  );
  const development2025 = bySeason(2025).filter((row) =>
    row.commenceTime >= '2025-05-01T00:00:00Z'
  );
  const final2026 = bySeason(2026);
  const splitIndex = Math.floor(development2025.length * 0.7);
  const train2025 = development2025.slice(0, splitIndex);
  const validation2025 = development2025.slice(splitIndex);
  if (train2025.length < 700 || validation2025.length < 300 || final2026.length < 300) {
    throw new Error('mlb_expected_runs_2025_2026_rows_insufficient');
  }
  const fullSelection = selectExpectedRunsFeatureSet(
    train2025,
    validation2025,
    { includeStarter: true }
  );
  const fallbackSelection = selectExpectedRunsFeatureSet(
    train2025,
    validation2025,
    { includeStarter: false }
  );
  const developmentRows = development2025;
  const finalModel = fitMlbExpectedRunsModel(
    buildMlbExpectedRunsExamples(developmentRows),
    { featureKeys: fullSelection.selected.featureKeys }
  );
  const fallbackModel = fitMlbExpectedRunsModel(
    buildMlbExpectedRunsExamples(developmentRows),
    { featureKeys: fallbackSelection.selected.featureKeys }
  );
  const fullTemperature = fitMoneylineTemperature(validation2025, finalModel);
  const fallbackTemperature = fitMoneylineTemperature(
    validation2025,
    fallbackModel
  );
  finalModel.moneylineTemperature = fullTemperature.temperature;
  fallbackModel.moneylineTemperature = fallbackTemperature.temperature;
  finalModel.fallbackModel = fallbackModel;
  const validation = scoreMetrics(validation2025, finalModel);
  const fallbackValidation = scoreMetrics(validation2025, fallbackModel);
  const finalTest = scoreMetrics(final2026, finalModel);
  const fallbackFinalObserved = scoreMetrics(final2026, fallbackModel);
  const strictStarterGames = completeProbableStarterGameIds();
  const routedFinalObserved = scoreMetrics(final2026, fallbackModel, {
    modelForRow: (row) =>
      strictStarterGames.has(row.gameId) ? finalModel : fallbackModel,
  });
  const starterIdentityCoverage = {
    development: probableStarterIdentityCoverage(developmentRows),
    finalObserved: probableStarterIdentityCoverage(final2026),
  };
  const beatsMoneylineMarket =
    finalTest.pitModelMoneyline.samples >= 500 &&
    finalTest.pitModelMoneyline.samples === finalTest.pitMarketMoneyline.samples &&
    finalTest.pitModelMoneyline.brier < finalTest.pitMarketMoneyline.brier &&
    finalTest.pitModelMoneyline.logLoss < finalTest.pitMarketMoneyline.logLoss;
  const beatsTotalsMarket =
    finalTest.totals.samples >= 300 &&
    finalTest.totals.samples === finalTest.pitMarketTotals.samples &&
    finalTest.totals.brier < finalTest.pitMarketTotals.brier &&
    finalTest.totals.logLoss < finalTest.pitMarketTotals.logLoss;
  const historicalStarterIdentityPitVerified =
    starterIdentityCoverage.finalObserved.featureRowPitRate >= 0.95 &&
    starterIdentityCoverage.finalObserved.rate >= 0.95;
  const finalTestPristine = false;
  const summary = {
    warning:
      '研究模式：v4.5 接入免費 API 前季 platoon；定邊用預期得分、validation 做溫度校準；2026只作已觀察回放。禁止把正 EV 海選當推薦。',
    split: {
      train2025: { samples: train2025.length, ...range(train2025) },
      validation2025: { samples: validation2025.length, ...range(validation2025) },
      observed2026: { samples: final2026.length, ...range(final2026) },
    },
    featureKeys: finalModel.featureKeys,
    fallbackFeatureKeys: fallbackModel.featureKeys,
    moneylineCalibration: {
      full: fullTemperature,
      fallback: fallbackTemperature,
    },
    featureAblation: {
      full: {
        selected: fullSelection.selected.key,
        candidates: fullSelection.candidates.map((candidate) => ({
          key: candidate.key,
          featureKeys: candidate.featureKeys,
          totalRunsMae: candidate.metrics.totalRunsMae,
          sideRunsRmse: candidate.metrics.sideRunsRmse,
          moneylineBrier: candidate.metrics.moneyline.brier,
        })),
      },
      fallback: {
        selected: fallbackSelection.selected.key,
        candidates: fallbackSelection.candidates.map((candidate) => ({
          key: candidate.key,
          featureKeys: candidate.featureKeys,
          totalRunsMae: candidate.metrics.totalRunsMae,
          sideRunsRmse: candidate.metrics.sideRunsRmse,
          moneylineBrier: candidate.metrics.moneyline.brier,
        })),
      },
    },
    featureContract: {
      trainServeAligned: true,
      includedSources: [
        'same_season_last_14_boxscore_batting',
        'same_season_last_7_boxscore_bullpen',
        'static_park_factor',
        'historical_starter_identity_for_training',
      ],
      excludedSources: [
        'feature_availability_indicators',
        'weather_not_selected_for_v43',
      ],
    },
    recommendationRules: MLB_MONEYLINE_RECOMMENDATION_RULES,
    starterIdentityCoverage,
    validation,
    fallbackValidation,
    finalTest,
    fallbackFinalObserved,
    routedFinalObserved,
    deploymentDecision: {
      eligible:
        finalTestPristine &&
        historicalStarterIdentityPitVerified &&
        beatsMoneylineMarket &&
        beatsTotalsMarket,
      finalTestPristine,
      historicalStarterIdentityPitVerified,
      beatsMoneylineMarket,
      beatsTotalsMarket,
      blockReasons: [
        'final_test_reused_for_feature_repair',
        ...(historicalStarterIdentityPitVerified
          ? []
          : ['forward_pit_starter_feature_rows_insufficient']),
        ...(beatsMoneylineMarket ? [] : ['score_model_does_not_beat_moneyline_market']),
        ...(beatsTotalsMarket ? [] : ['score_model_does_not_beat_totals_market']),
      ],
    },
  };
  const run = {
    runId: `mlb-xruns-${randomUUID()}`,
    modelVersion: MLB_EXPECTED_RUNS_MODEL_VERSION,
    featureVersion: MLB_BASELINE_FEATURE_VERSION,
    model: finalModel,
    summary,
  };
  if (persist) {
    db.prepare(`
      INSERT INTO mlb_expected_runs_models
        (run_id, model_version, feature_version, training_from, training_to,
         train_samples, model_json, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.runId,
      run.modelVersion,
      run.featureVersion,
      developmentRows[0].commenceTime,
      developmentRows.at(-1).commenceTime,
      developmentRows.length,
      JSON.stringify(finalModel),
      JSON.stringify(summary)
    );
  }
  return run;
}

/** v4.5 正式選中集（消融底座；勿與 v4.5 再現路徑混用） */
export const MLB_V45_SELECTED_FEATURE_KEYS = Object.freeze([
  ...MLB_EXPECTED_RUNS_CORE_FEATURE_KEYS,
  ...MLB_EXPECTED_RUNS_BATTING_FEATURE_KEYS,
  ...MLB_EXPECTED_RUNS_PLATOON_FEATURE_KEYS,
]);

function identityFlagRates(rows) {
  let sides = 0;
  let il = 0;
  let sparse = 0;
  let daysSum = 0;
  let daysLt365 = 0;
  let gsSum = 0;
  for (const row of rows) {
    for (const side of ['home', 'away']) {
      sides += 1;
      const flags = resolveMlbOpponentStarterIdentityFlags(row.features, side);
      if (flags.opponentStarterIsReturnFromIl) il += 1;
      if (flags.opponentStarterIsSparseStart) sparse += 1;
      daysSum += flags.opponentStarterDaysSinceIlExit;
      if (flags.opponentStarterDaysSinceIlExit < MLB_IL_DAYS_SINCE_EXIT_MISSING) {
        daysLt365 += 1;
      }
      gsSum += flags.opponentStarterSeasonGs;
    }
  }
  return {
    sides,
    ilRate: sides ? il / sides : 0,
    sparseStartRate: sides ? sparse / sides : 0,
    daysSinceIlExitMean: sides ? daysSum / sides : null,
    daysSinceIlExitObservedRate: sides ? daysLt365 / sides : 0,
    seasonGsMean: sides ? gsSum / sides : null,
  };
}

function runV46CandidateAblation({
  modelVersion,
  candidateFactory,
  warning,
  extraSummary = {},
  persist = false,
}) {
  const rows = loadRows();
  const bySeason = (season) => rows.filter((row) =>
    String(row.commenceTime).startsWith(String(season))
  );
  const development2025 = bySeason(2025).filter((row) =>
    row.commenceTime >= '2025-05-01T00:00:00Z'
  );
  const final2026 = bySeason(2026);
  const splitIndex = Math.floor(development2025.length * 0.7);
  const train2025 = development2025.slice(0, splitIndex);
  const validation2025 = development2025.slice(splitIndex);
  if (train2025.length < 700 || validation2025.length < 300 || final2026.length < 300) {
    throw new Error('mlb_expected_runs_v46_rows_insufficient');
  }

  const trainExamples = buildMlbExpectedRunsExamples(train2025);
  const developmentExamples = buildMlbExpectedRunsExamples(development2025);
  const candidateFits = candidateFactory().map((candidate) => {
    const trainModel = fitMlbExpectedRunsModel(trainExamples, {
      featureKeys: candidate.featureKeys,
    });
    const validation = scoreMetrics(validation2025, trainModel);
    return {
      ...candidate,
      trainModel,
      validation,
      totalRunsMae: validation.totalRunsMae,
      moneylineBrier: validation.moneyline.brier,
    };
  });

  const bestTotalRunsMae = Math.min(...candidateFits.map((c) => c.totalRunsMae));
  const selected = [...candidateFits]
    .filter((c) => c.totalRunsMae <= bestTotalRunsMae + 0.02)
    .sort((a, b) =>
      a.moneylineBrier - b.moneylineBrier ||
      a.totalRunsMae - b.totalRunsMae ||
      a.featureKeys.length - b.featureKeys.length
    )[0];

  const candidates = candidateFits.map((candidate) => {
    const finalModel = fitMlbExpectedRunsModel(developmentExamples, {
      featureKeys: candidate.featureKeys,
    });
    const temperature = fitMoneylineTemperature(validation2025, finalModel);
    finalModel.moneylineTemperature = temperature.temperature;
    finalModel.modelVersion = modelVersion;
    const observed2026 = scoreMetrics(final2026, finalModel);
    return {
      key: candidate.key,
      featureKeys: candidate.featureKeys,
      validation: {
        totalRunsMae: candidate.totalRunsMae,
        moneylineBrier: candidate.moneylineBrier,
        moneyline: candidate.validation.moneyline,
      },
      temperature: temperature.temperature,
      observed2026: {
        totalRunsMae: observed2026.totalRunsMae,
        moneylineBrier: observed2026.moneyline.brier,
        moneyline: observed2026.moneyline,
        expectedRunsSideBets: observed2026.expectedRunsSideBets,
      },
      model: finalModel,
      selectedByProtocol: candidate.key === selected.key,
    };
  });

  const base = candidates.find((c) => c.key === 'base_v45');
  const winner = candidates.find((c) => c.selectedByProtocol) || base;
  const modelGate = {
    validationBrierOk:
      winner.validation.moneylineBrier <= base.validation.moneylineBrier + 1e-12,
    observed2026BrierOk:
      winner.observed2026.moneylineBrier <= base.observed2026.moneylineBrier + 0.001,
    validationBrierDelta:
      winner.validation.moneylineBrier - base.validation.moneylineBrier,
    observed2026BrierDelta:
      winner.observed2026.moneylineBrier - base.observed2026.moneylineBrier,
  };

  const summary = {
    warning,
    protocol: 'MLB-V46-TRAINING-PROTOCOL',
    ...extraSummary,
    split: {
      train2025: { samples: train2025.length, ...range(train2025) },
      validation2025: { samples: validation2025.length, ...range(validation2025) },
      observed2026: { samples: final2026.length, ...range(final2026) },
    },
    identityFlagRates: {
      development: identityFlagRates(development2025),
      observed2026: identityFlagRates(final2026),
    },
    selectedKey: winner.key,
    modelGate,
    candidates: candidates.map((c) => ({
      key: c.key,
      featureKeys: c.featureKeys,
      selectedByProtocol: c.selectedByProtocol,
      validation: c.validation,
      temperature: c.temperature,
      observed2026: {
        totalRunsMae: c.observed2026.totalRunsMae,
        moneylineBrier: c.observed2026.moneylineBrier,
        moneyline: c.observed2026.moneyline,
        expectedRunsSide: c.observed2026.expectedRunsSideBets,
      },
    })),
  };

  const run = {
    runId: `mlb-xruns-v46-${randomUUID()}`,
    modelVersion,
    featureVersion: MLB_BASELINE_FEATURE_VERSION,
    model: winner.model,
    modelsByKey: Object.fromEntries(candidates.map((c) => [c.key, c.model])),
    summary,
  };

  if (persist) {
    db.prepare(`
      INSERT INTO mlb_expected_runs_models
        (run_id, model_version, feature_version, training_from, training_to,
         train_samples, model_json, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.runId,
      run.modelVersion,
      run.featureVersion,
      development2025[0].commenceTime,
      development2025.at(-1).commenceTime,
      development2025.length,
      JSON.stringify(winner.model),
      JSON.stringify(summary)
    );
  }
  return run;
}

function expectedRunsV46FeatureCandidates() {
  const base = [...MLB_V45_SELECTED_FEATURE_KEYS];
  const il = 'opponentStarterIsReturnFromIl';
  const sparse = 'opponentStarterIsSparseStart';
  return [
    { key: 'base_v45', featureKeys: base },
    { key: 'base_plus_il_return', featureKeys: [...base, il] },
    { key: 'base_plus_sparse_start', featureKeys: [...base, sparse] },
    { key: 'base_plus_il_and_sparse', featureKeys: [...base, il, sparse] },
  ];
}

function expectedRunsV46Rc2FeatureCandidates() {
  const base = [...MLB_V45_SELECTED_FEATURE_KEYS];
  const days = 'opponentStarterDaysSinceIlExit';
  const gs = 'opponentStarterSeasonGs';
  return [
    { key: 'base_v45', featureKeys: base },
    { key: 'rc2a_days_since_il', featureKeys: [...base, days] },
    { key: 'rc2b_season_gs', featureKeys: [...base, gs] },
  ];
}

/**
 * v4.6-rc 消融：同一訓練窗、四候選；預設不寫庫（避免蓋過正式 v4.5）。
 */
export function runMlbExpectedRunsV46RcAblation({ persist = false } = {}) {
  return runV46CandidateAblation({
    modelVersion: MLB_EXPECTED_RUNS_V46_RC_MODEL_VERSION,
    candidateFactory: expectedRunsV46FeatureCandidates,
    warning:
      'v4.6-rc 研究消融：不改鎖定 B 選注；未過雙層閘前禁止升格正式版號。',
    extraSummary: {
      sparseStart: {
        rule: 'season_gs in [1,3] AND pitcher_team_wins_plus_losses >= 15',
        minTeamGames: MLB_SPARSE_START_MIN_TEAM_GAMES,
      },
    },
    persist,
  });
}

/**
 * v4.6-rc2：二元旗標改連續值（daysSinceIlExit / season_gs）；預設不寫庫。
 */
export function runMlbExpectedRunsV46Rc2Ablation({ persist = false } = {}) {
  return runV46CandidateAblation({
    modelVersion: MLB_EXPECTED_RUNS_V46_RC2_MODEL_VERSION,
    candidateFactory: expectedRunsV46Rc2FeatureCandidates,
    warning:
      'v4.6-rc2：只改 IL/sparse 表達為連續值；訓練窗與雙層閘不變；未過閘不升格。',
    extraSummary: {
      encoding: {
        daysSinceIlExit: `continuous; missing=${MLB_IL_DAYS_SINCE_EXIT_MISSING}; clamp[0,${MLB_IL_DAYS_SINCE_EXIT_MISSING}]`,
        seasonGs: 'continuous gamesStarted; missing=0; clamp[0,40]',
      },
    },
    persist,
  });
}

export function getLatestMlbExpectedRunsValidation({
  modelVersion = MLB_EXPECTED_RUNS_MODEL_VERSION,
} = {}) {
  let row = null;
  if (modelVersion) {
    row = db.prepare(`
      SELECT * FROM mlb_expected_runs_models
      WHERE model_version = ?
      ORDER BY datetime(created_at) DESC, rowid DESC
      LIMIT 1
    `).get(modelVersion);
  }
  if (!row) {
    row = db.prepare(`
      SELECT * FROM mlb_expected_runs_models
      ORDER BY datetime(created_at) DESC, rowid DESC
      LIMIT 1
    `).get();
  }
  if (!row) return null;
  return {
    runId: row.run_id,
    modelVersion: row.model_version,
    featureVersion: row.feature_version,
    createdAt: row.created_at,
    model: JSON.parse(row.model_json),
    summary: JSON.parse(row.summary_json),
  };
}
