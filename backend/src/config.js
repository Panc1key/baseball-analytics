import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

function loadJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const fittedWeights = loadJsonSafe(path.join(__dirname, '../data/fitted-weights.json'));
const dixonColesFit = loadJsonSafe(path.join(__dirname, '../data/dixon-coles.json'));

export const config = {
  modelVersion: process.env.MODEL_VERSION || 'baseball-v2.9.1',
  /**
   * 新 MLB 真實資料／紙上研究管線的安全開關。
   * 預設禁止舊 recommendations、flat_bet、串關與建議注碼產生新訊號。
   */
  // MLB 舊推薦尚未通過 PIT 驗證，禁止以環境變數繞過研究模式。
  mlbTruthResearchOnly: true,
  /** 近月回放失準，舊 MLB totals 管線一律停用。 */
  enableMlbLegacyTotals: process.env.ENABLE_MLB_LEGACY_TOTALS === 'true',
  /** 研究基準模型與去水市場差距不足時，明確輸出無訊號。 */
  mlbBaselineMinMarketGap: parseFloat(process.env.MLB_BASELINE_MIN_MARKET_GAP || '0.03'),
  /** SSOT：泊松獨贏權重下限（Elo/Log5 不得反客為主） */
  ssotPoissonMinWeight: parseFloat(process.env.SSOT_POISSON_MIN_WEIGHT || '0.72'),
  /** NPB/KBO 滾動 Elo */
  baseballEloK: parseFloat(process.env.BASEBALL_ELO_K || '22'),
  baseballEloHomeAdv: parseFloat(process.env.BASEBALL_ELO_HOME_ADV || '35'),
  /** 分箱可靠度校準（回測建表後啟用；回測過程本身關閉） */
  enableReliabilityCalibration: process.env.ENABLE_RELIABILITY_CALIBRATION !== 'false',
  /** 可靠度表必須與目前模型版本一致，且精確切片達最低樣本數 */
  reliabilityMinSliceSamples: parseInt(
    process.env.RELIABILITY_MIN_SLICE_SAMPLES || '50',
    10
  ),
  /** Dixon–Coles 低分相關（可由 fit 寫入 data/dixon-coles.json） */
  dixonColesRhoNpb: parseFloat(
    process.env.DIXON_COLES_RHO_NPB ||
      String(dixonColesFit?.NPB?.rho ?? '0')
  ),
  dixonColesRhoKbo: parseFloat(
    process.env.DIXON_COLES_RHO_KBO ||
      String(dixonColesFit?.KBO?.rho ?? '0')
  ),
  /** 獨贏膠著：勝率差距低於此視為難分（0.10 = 55/45） */
  h2hAmbiguousMaxGap: parseFloat(process.env.H2H_AMBIGUOUS_MAX_GAP || '0.10'),
  /** 獨贏膠著：熱門勝率低於此改走大小優先 */
  h2hAmbiguousMaxFav: parseFloat(process.env.H2H_AMBIGUOUS_MAX_FAV || '0.58'),
  /** 膠著時仍允許獨贏的清晰度門檻 */
  h2hClearFavoriteProb: parseFloat(process.env.H2H_CLEAR_FAV_PROB || '0.62'),
  h2hClearMinEdgePct: parseFloat(process.env.H2H_CLEAR_MIN_EDGE_PCT || '6'),
  /** 膠著時大小盤 actionable 加分（對沖 totals 主推罰分） */
  totalsAmbiguousBoost: parseFloat(process.env.TOTALS_AMBIGUOUS_BOOST || '6'),
  settlementVoidAfterHours: Math.max(
    48,
    parseInt(process.env.SETTLEMENT_VOID_AFTER_HOURS || '72', 10)
  ),
  port: parseInt(process.env.PORT || '3101', 10),
  oddsApiKey: process.env.ODDS_API_KEY || '',
  minEvThreshold: parseFloat(process.env.MIN_EV_THRESHOLD || '0.03'),
  minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0.55'),
  maxParlayLegs: parseInt(process.env.MAX_PARLAY_LEGS || '20', 10),
  /** 六合彩型大串：最多腿數（0 = 不限制，取當日全部場次） */
  parlayLotteryMaxLegs: parseInt(process.env.PARLAY_LOTTERY_MAX_LEGS || '0', 10),
  /** 大串補腿最低勝率（無錨腿時用主盤補滿場次） */
  parlayLotteryMinProb: parseFloat(process.env.PARLAY_LOTTERY_MIN_PROB || '0.48'),
  /** 大串補腿最高賠率（允許略高水以涵蓋全場） */
  parlayLotteryMaxLegOdds: parseFloat(process.env.PARLAY_LOTTERY_MAX_LEG_ODDS || '2.25'),
  flatBetUsd: parseFloat(process.env.FLAT_BET_USD || process.env.BASE_STAKE_UNIT || '10'),
  /** 基準均注單位（建議投注額計算基數） */
  baseStakeUnit: parseFloat(process.env.BASE_STAKE_UNIT || process.env.FLAT_BET_USD || '10'),
  stakeCurrencyLabel: process.env.STAKE_CURRENCY_LABEL || '元',
  stakeMinMultiplier: parseFloat(process.env.STAKE_MIN_MULTIPLIER || '0.3'),
  stakeMaxMultiplier: parseFloat(process.env.STAKE_MAX_MULTIPLIER || '2'),
  stakeMinAmount: parseFloat(process.env.STAKE_MIN_AMOUNT || '3'),
  stakeMaxAmount: parseFloat(process.env.STAKE_MAX_AMOUNT || '20'),
  stakeRoundStep: parseFloat(process.env.STAKE_ROUND_STEP || '1'),
  /** 串關錨腿建議額 = 基準均注 × 此比例 */
  parlayAnchorStakeRatio: parseFloat(process.env.PARLAY_ANCHOR_STAKE_RATIO || '0.35'),
  parlayBetUsd: parseFloat(process.env.PARLAY_BET_USD || '1'),
  syncCron: process.env.SYNC_CRON || '0 8,14,20 * * *',
  /**
   * MLB 賽前快照排程。排程只由後端執行；前端重新載入只讀 SQLite。
   * 固定時段用於全日掃描，開賽前窗口由每 5 分鐘檢查器補足。
   */
  prematchSchedulerEnabled: process.env.PREMATCH_SCHEDULER_ENABLED !== 'false',
  prematchSnapshotTimezone: process.env.PREMATCH_SNAPSHOT_TIMEZONE || 'Asia/Taipei',
  prematchFixedSnapshotHours: process.env.PREMATCH_FIXED_SNAPSHOT_HOURS || '1,3,5,13,15,17',
  prematchWindowCheckCron: process.env.PREMATCH_WINDOW_CHECK_CRON || '*/5 * * * *',
  prematchSnapshotWindowsMinutes: (process.env.PREMATCH_SNAPSHOT_WINDOWS_MINUTES || '1440,360,180,90,30,5')
    .split(',')
    .map((value) => parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0),
  prematchSchedulerGraceMinutes: parseInt(
    process.env.PREMATCH_SCHEDULER_GRACE_MINUTES || '12',
    10
  ),
  staleDataHours: parseFloat(process.env.STALE_DATA_HOURS || '3'),
  /** 已開賽但仍可推薦的滾球窗口（小時，MLB 一場約 3h） */
  liveGameGraceHours: parseFloat(process.env.LIVE_GAME_GRACE_HOURS || '6'),
  /** 初盤分析向前看多少小時（48 = 約 2 天；7天 = 168） */
  upcomingGameHorizonHours: parseFloat(process.env.UPCOMING_GAME_HORIZON_HOURS || '48'),
  /** 前端按日 Slate 預設顯示天數（省額度可設 2） */
  slateDefaultDays: parseInt(process.env.SLATE_DEFAULT_DAYS || '2', 10),
  /** 推薦列表時區（香港 UTC+8） */
  displayTimezone: process.env.DISPLAY_TIMEZONE || 'Asia/Hong_Kong',
  /**
   * 未指定 sports 時的預設同步範圍（排程／舊客戶端）
   * 前端頂部按鈕會傳當前頁面對應運動；預設改為只跑棒球以省時間與額度
   */
  slateRefreshSports: (process.env.SLATE_REFRESH_SPORTS || 'baseball')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  recommendPrimaryScore: parseFloat(process.env.RECOMMEND_PRIMARY_SCORE || '65'),
  recommendWatchScore: parseFloat(process.env.RECOMMEND_WATCH_SCORE || '50'),
  /**
   * 嚴格門檻無候選時，仍從主盤選最佳方向標為 sample（供樣本累積／回測）
   * 不進均注；僅影響初盤推薦覆蓋率
   */
  prematchSampleFallback: process.env.PREMATCH_SAMPLE_FALLBACK !== 'false',
  sampleMinEv: parseFloat(process.env.SAMPLE_MIN_EV || process.env.MIN_EV_THRESHOLD || '0.03'),
  sampleMinOdds: parseFloat(process.env.SAMPLE_MIN_ODDS || process.env.PREMATCH_MIN_ODDS || '1.75'),
  /** 樣本獨贏最低勝率：禁止 37%/43% 這類冷門當「推薦」展示 */
  sampleMinH2hProb: parseFloat(process.env.SAMPLE_MIN_H2H_PROB || '0.52'),
  maxPicksPerGame: parseInt(process.env.MAX_PICKS_PER_GAME || '3', 10),
  /** 同一場次最多均注腿數（不同盤口各一） */
  maxFlatBetsPerGame: parseInt(process.env.MAX_FLAT_BETS_PER_GAME || '1', 10),
  enablePlayerProps: process.env.ENABLE_PLAYER_PROPS === 'true',
  maxPropGames: parseInt(process.env.MAX_PROP_GAMES || '6', 10),
  minParlayLegOdds: parseFloat(process.env.MIN_PARLAY_LEG_ODDS || '1.4'),
  /** 舊管線相容設定；MLB 新研究管線不允許用固定市場加幅產生機率。 */
  maxModelEdgePct: Math.min(
    0.06,
    parseFloat(process.env.MAX_MODEL_EDGE_PCT || '0.06')
  ),
  /** 串關每腿最低 EV（與單場門檻一致） */
  parlayMinLegEv: parseFloat(process.env.PARLAY_MIN_LEG_EV || '0.03'),
  /** 獨贏：市場混合權重（數據完整時） */
  h2hMarketBlendMlbFull: parseFloat(process.env.H2H_MARKET_BLEND_MLB_FULL || '0.4'),
  h2hMarketBlendMlb: parseFloat(process.env.H2H_MARKET_BLEND_MLB || '0.45'),
  h2hMarketBlendMlbLite: parseFloat(process.env.H2H_MARKET_BLEND_MLB_LITE || '0.5'),
  h2hMarketBlendOther: parseFloat(process.env.H2H_MARKET_BLEND_OTHER || '0.55'),
  /** NPB/KBO 有 Elo+得失分時貼市權重（可用 fit-blend 驗證集估計） */
  h2hMarketBlendNpbFull: parseFloat(
    process.env.H2H_MARKET_BLEND_NPB_FULL ||
      String(fittedWeights?.h2hMarketBlendNpbFull ?? '0.38')
  ),
  /** 泊松權重（SSOT；fit-blend 結果仍受 ssotPoissonMinWeight 托底） */
  scoreModelBlendNpb: parseFloat(
    process.env.SCORE_MODEL_BLEND_NPB ||
      String(fittedWeights?.scoreModelBlendNpb ?? '0.8')
  ),
  totalsMarketBlendNpbFull: parseFloat(
    process.env.TOTALS_MARKET_BLEND_NPB_FULL ||
      String(fittedWeights?.totalsMarketBlendNpbFull ?? '0.42')
  ),
  /** NPB/KBO 獨贏：最低領先第二方差距 */
  h2hMinProbGapNpb: parseFloat(process.env.H2H_MIN_PROB_GAP_NPB || '0.06'),
  /** NPB/KBO 獨贏：最低熱門勝率 */
  h2hMinFavoriteProbNpb: parseFloat(process.env.H2H_MIN_FAV_NPB || '0.56'),
  /** NPB/KBO 獨贏最小優勢%（比 MLB 嚴） */
  h2hMinEdgePctNpb: parseFloat(process.env.H2H_MIN_EDGE_PCT_NPB || '3.0'),
  /** NPB 均注最低勝率 / 優勢（勝率優先） */
  // 與主推門檻對齊：避免「有主推卻永遠不成均注」
  flatBetMinProbNpb: parseFloat(process.env.FLAT_BET_MIN_PROB_NPB || '0.58'),
  flatBetMinEdgePctNpb: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT_NPB || '3.5'),
  flatBetMinDataQualityNpb: parseFloat(process.env.FLAT_BET_MIN_DQ_NPB || '0.70'),
  /** +1.5 進均注的最低蓋盤率 */
  flatBetPlus15MinCover: parseFloat(process.env.FLAT_BET_PLUS15_MIN_COVER || '0.62'),
  /** 初盤推薦最低賠率（避開 1.4x 臭水／鎖死熱門；觀察與主推統一 ≥1.75） */
  prematchMinOdds: parseFloat(process.env.PREMATCH_MIN_ODDS || '1.75'),
  /** 初盤主推最低賠率 */
  prematchPrimaryMinOdds: parseFloat(process.env.PREMATCH_PRIMARY_MIN_ODDS || '1.75'),
  /**
   * 主推最低模型勝率（可下注層）
   * 0.58：回測 55–60% 桶約 57–58%，兼顧出單量；均注另用更嚴的 0.60
   */
  prematchPrimaryMinProb: parseFloat(process.env.PREMATCH_PRIMARY_MIN_PROB || '0.58'),
  /** MLB 大小：主推另需達到此勝率（回測 MLB totals ≈50%，加嚴） */
  mlbTotalsPrimaryMinProb: parseFloat(process.env.MLB_TOTALS_PRIMARY_MIN_PROB || '0.60'),
  /** MLB 大小是否允許進均注（回測命中偏弱，預設關閉） */
  flatBetAllowMlbTotals: process.env.FLAT_BET_ALLOW_MLB_TOTALS === 'true',
  /** NPB 大小進均注（回測 NPB totals ≈62%，預設開放） */
  flatBetAllowNpbTotals: process.env.FLAT_BET_ALLOW_NPB_TOTALS !== 'false',
  /** KBO 大小進均注（與 NPB 同規則；預設開放） */
  flatBetAllowKboTotals: process.env.FLAT_BET_ALLOW_KBO_TOTALS !== 'false',
  /** NPB/KBO 隊力最低場次（庫內歷史有限時 20 太嚴，預設 15） */
  npbMinGamesForStrength: parseInt(process.env.NPB_MIN_GAMES_FOR_STRENGTH || '15', 10),
  /** 近窗形態天數（完賽累積 OBP/SLG/RPG，預設 30） */
  rollingFormDays: parseInt(process.env.ROLLING_FORM_DAYS || '30', 10),
  /** 近窗形態最少場次才覆寫賽季 RPG */
  rollingFormMinGames: parseInt(process.env.ROLLING_FORM_MIN_GAMES || '8', 10),
  /**
   * 棒球重計算快取（小時）：未過期則略過 Yahoo / Elo / 近窗，加速同步
   * 賠率與比分每次仍會抓；forceHeavyRebuild=true 時無視快取
   */
  baseballYahooMaxAgeHours: parseFloat(process.env.BASEBALL_YAHOO_MAX_AGE_HOURS || '6'),
  baseballEloMaxAgeHours: parseFloat(process.env.BASEBALL_ELO_MAX_AGE_HOURS || '4'),
  baseballRollingMaxAgeHours: parseFloat(process.env.BASEBALL_ROLLING_MAX_AGE_HOURS || '3'),
  /** MLB 近窗聯盟基準 OPS / WHIP（形態乘數錨點） */
  mlbRollingLeagueOps: parseFloat(process.env.MLB_ROLLING_LEAGUE_OPS || '0.720'),
  mlbRollingLeagueWhip: parseFloat(process.env.MLB_ROLLING_LEAGUE_WHIP || '1.28'),
  /** NPB baseball-data 隊級基準 OPS / WHIP（約 2026 季中均值） */
  npbRollingLeagueOps: parseFloat(process.env.NPB_ROLLING_LEAGUE_OPS || '0.670'),
  npbRollingLeagueWhip: parseFloat(process.env.NPB_ROLLING_LEAGUE_WHIP || '1.22'),
  /** 是否用 baseball-data.com 隊級 OPS/WHIP 調 NPB λ（回測對照可設 false） */
  enableNpbBaseballDataForm: process.env.ENABLE_NPB_BASEBALL_DATA_FORM !== 'false',
  /** KBO 官網隊級基準 OPS / WHIP（約 2026 季中均值） */
  kboRollingLeagueOps: parseFloat(process.env.KBO_ROLLING_LEAGUE_OPS || '0.745'),
  kboRollingLeagueWhip: parseFloat(process.env.KBO_ROLLING_LEAGUE_WHIP || '1.46'),
  /** 是否用 eng.koreabaseball.com 隊級 OPS/WHIP 調 KBO λ */
  enableKboOfficialForm: process.env.ENABLE_KBO_OFFICIAL_FORM !== 'false',
  /** KBO 當日先發（官網 GetKboGameList + PitcherDetail）調 λ；預設開 */
  enableKboPitchers: process.env.ENABLE_KBO_PITCHERS !== 'false',
  /** KBO 先發對對手得分影響相對 MLB 的縮放（避免與隊級 WHIP 雙重） */
  kboPitcherSuppressionScale: parseFloat(process.env.KBO_PITCHER_SUPPRESSION_SCALE || '0.65'),
  /** NPB 先發縮放（接上先發資料後生效） */
  npbPitcherSuppressionScale: parseFloat(process.env.NPB_PITCHER_SUPPRESSION_SCALE || '0.55'),
  /** 有當日先發時，隊級投手群 WHIP 權重（0–1） */
  asianStaffWhipWhenPitcher: parseFloat(process.env.ASIAN_STAFF_WHIP_WHEN_PITCHER || '0.4'),
  /**
   * MLB 明星打者缺陣加權（實驗開關，預設關）
   * 初盤：傷兵名單姓名；回測：當日 boxscore 是否出場
   */
  enableStarImpact: process.env.ENABLE_STAR_IMPACT === 'true',
  /** 單隊明星缺陣對勝率懲罰上限 */
  starImpactMaxPenalty: parseFloat(process.env.STAR_IMPACT_MAX_PENALTY || '0.04'),
  /**
   * 高球場係數主場獨贏：≥此值禁止進均注（Coors=1.18；防洛磯類過信）
   */
  flatBetBlockHomeMlMinParkFactor: parseFloat(
    process.env.FLAT_BET_BLOCK_HOME_ML_MIN_PARK || '1.12'
  ),
  /** 均注模型勝率上限（超過視為過信，洛磯/大分 74% 類） */
  flatBetMaxModelProb: parseFloat(process.env.FLAT_BET_MAX_MODEL_PROB || '0.72'),
  /** 主推上限：超過則降為觀察（避免 74% 主推造成幻覺信心） */
  primaryMaxModelProb: parseFloat(process.env.PRIMARY_MAX_MODEL_PROB || '0.72'),
  /** −1.5 讓分均注最低蓋盤率（韓華 68% 類偏鬆） */
  flatBetMinus15MinCover: parseFloat(process.env.FLAT_BET_MINUS15_MIN_COVER || '0.70'),
  /** 獨贏均注最低模型勝率（整季 A/B：0.64 命中/ROI 優於關閉） */
  flatBetMinProbH2h: parseFloat(process.env.FLAT_BET_MIN_PROB_H2H || '0.64'),
  /** preferTotals 時獨贏不得進均注（推理已寫優先大小卻仍推獨贏均注） */
  flatBetBlockH2hWhenPreferTotals: process.env.FLAT_BET_BLOCK_H2H_PREFER_TOTALS !== 'false',
  /** 無得分模型時禁止用 +1.5（NPB/KBO） */
  spreadsBlockPlus15WithoutScoreModel: process.env.SPREADS_BLOCK_PLUS15_NO_SCORE !== 'false',
  /** 獨贏推薦：模型與市場最小優勢（%） */
  h2hMinEdgePct: parseFloat(process.env.H2H_MIN_EDGE_PCT || '1.5'),
  /** 獨贏：避免 50/50 場次 */
  h2hMinConfidence: parseFloat(process.env.H2H_MIN_CONFIDENCE || '0.08'),
  /** 讓分：最小蓋盤機率（命中率門檻） */
  spreadsMinCoverProb: parseFloat(process.env.SPREADS_MIN_COVER_PROB || '0.58'),
  /** 讓分：模型相對市場最小優勢（%） */
  spreadsMinEdgePct: parseFloat(process.env.SPREADS_MIN_EDGE_PCT || '2.5'),
  /** 讓分：模型勝率校準上限（比獨贏更保守） */
  spreadsMaxModelEdgePct: parseFloat(process.env.SPREADS_MAX_MODEL_EDGE_PCT || '0.05'),
  /** +1.5 不再固定扣分；改由假弱方證據與最終 edge 護欄判斷 */
  spreadsPlus15PrimaryPenalty: parseFloat(process.env.SPREADS_PLUS15_PRIMARY_PENALTY || '0'),
  /** 讓分：受让最低獨贏勝率 */
  spreadsMinDogWinProb: parseFloat(process.env.SPREADS_MIN_DOG_WIN_PROB || '0.47'),
  /** 讓分：模型看衰對手時最大可接受差距 */
  spreadsMaxModelDeficit: parseFloat(process.env.SPREADS_MAX_MODEL_DEFICIT || '0.03'),
  /** 讓分 +1.5：得分模型預期分差低於此值禁止（客隊視角） */
  spreadsMinExpectedMargin: parseFloat(process.env.SPREADS_MIN_EXPECTED_MARGIN || '-0.35'),
  /** 讓分：先發劣勢超過此值禁止受让 */
  spreadsMaxPitcherDeficit: parseFloat(process.env.SPREADS_MAX_PITCHER_DEFICIT || '0.025'),
  /** 得分模型混合權重（有完整 MLB 數據 + 先發） */
  /** 泊松權重（SSOT：預設偏高；實際仍受 ssotPoissonMinWeight 托底） */
  scoreModelBlendMlbFull: parseFloat(process.env.SCORE_MODEL_BLEND_MLB_FULL || '0.85'),
  scoreModelBlendMlb: parseFloat(process.env.SCORE_MODEL_BLEND_MLB || '0.75'),
  /** 讓分蓋盤率市場混合權重 */
  spreadsMarketBlend: parseFloat(process.env.SPREADS_MARKET_BLEND || '0.45'),
  /** 全場大串補腿最高賠率（允許強隊獨贏進串） */
  parlaySlateMaxLegOdds: parseFloat(process.env.PARLAY_SLATE_MAX_LEG_ODDS || '2.5'),
  /** 全場大串：僅用主推（primary） */
  parlaySlatePrimaryOnly: process.env.PARLAY_SLATE_PRIMARY_ONLY !== 'false',
  /** 全場大串：每腿最低勝率 */
  parlaySlateMinProb: parseFloat(process.env.PARLAY_SLATE_MIN_PROB || '0.52'),
  /** 全場大串：+1.5 讓分最低蓋盤率 */
  parlaySlateSpreadPlus15MinProb: parseFloat(process.env.PARLAY_SLATE_PLUS15_MIN_PROB || '0.58'),
  /** 全場大串：每腿最低 EV（排除負 EV 觀察單） */
  parlaySlateMinEv: parseFloat(process.env.PARLAY_SLATE_MIN_EV || '0'),
  /** 全場大串：無主推時是否用市場補腿（命中率模式建議 false） */
  parlaySlateAllowMarketFill: process.env.PARLAY_SLATE_ALLOW_MARKET_FILL === 'true',
  /** 小球：模型需低於市場盤口的最小差距 */
  totalsMinUnderGap: parseFloat(process.env.TOTALS_MIN_UNDER_GAP || '0.5'),
  /** 小球：最低優勢%（比大球更嚴） */
  totalsMinUnderEdgePct: parseFloat(process.env.TOTALS_MIN_UNDER_EDGE_PCT || '6'),
  /** 小球：模型概率校準上限（比大球保守） */
  totalsUnderMaxModelEdgePct: parseFloat(process.env.TOTALS_UNDER_MAX_MODEL_EDGE_PCT || '0.05'),
  /** 小球：球場係數上限（偏高打場禁止） */
  totalsMaxUnderParkFactor: parseFloat(process.env.TOTALS_MAX_UNDER_PARK_FACTOR || '1.03'),
  /** 小球：兩隊場均進攻上限（相對聯盟） */
  totalsMaxUnderOffenseRpg: parseFloat(process.env.TOTALS_MAX_UNDER_OFFENSE_RPG || '0.3'),
  /** 大小盤：市場混合權重 */
  totalsMarketBlendMlbFull: parseFloat(process.env.TOTALS_MARKET_BLEND_MLB_FULL || '0.6'),
  totalsMarketBlendMlb: parseFloat(process.env.TOTALS_MARKET_BLEND_MLB || '0.65'),
  totalsMarketBlendMlbLite: parseFloat(process.env.TOTALS_MARKET_BLEND_MLB_LITE || '0.7'),
  totalsMarketBlendOther: parseFloat(process.env.TOTALS_MARKET_BLEND_OTHER || '0.75'),
  /** 大小盤推薦門檻 */
  totalsMinEdgePct: parseFloat(process.env.TOTALS_MIN_EDGE_PCT || '2'),
  totalsMinContrarianEdgePct: parseFloat(process.env.TOTALS_MIN_CONTRARIAN_EDGE_PCT || '5'),
  totalsMinLineGap: parseFloat(process.env.TOTALS_MIN_LINE_GAP || '0.4'),
  totalsMinModelMarketGap: parseFloat(process.env.TOTALS_MIN_MODEL_MARKET_GAP || '0.35'),
  totalsMaxModelMarketGap: parseFloat(process.env.TOTALS_MAX_MODEL_MARKET_GAP || '1.2'),
  totalsMinEv: parseFloat(process.env.TOTALS_MIN_EV || '0.03'),
  /** NPB/KBO 全場大小合理盤帶（低於下限多半是滾球縮水／局數盤） */
  npbTotalsLineMin: parseFloat(process.env.NPB_TOTALS_LINE_MIN || '6.5'),
  npbTotalsLineMax: parseFloat(process.env.NPB_TOTALS_LINE_MAX || '13'),
  /** MLB 全場大小合理盤帶 */
  mlbTotalsLineMin: parseFloat(process.env.MLB_TOTALS_LINE_MIN || '5.5'),
  mlbTotalsLineMax: parseFloat(process.env.MLB_TOTALS_LINE_MAX || '14'),
  /** 市場線比模型低超過此值時禁止博大（防滾球低線假 EV） */
  totalsSoftLineOverGap: parseFloat(process.env.TOTALS_SOFT_LINE_OVER_GAP || '1.5'),
  /** 單場主推：大小盤評分折扣（避免大小霸佔主推） */
  totalsPrimaryScorePenalty: parseFloat(process.env.TOTALS_PRIMARY_SCORE_PENALTY || '15'),
  /** 均注精選：與主推最低賠率對齊（預設 1.75） */
  flatBetMinOdds: parseFloat(process.env.FLAT_BET_MIN_ODDS || '1.75'),
  /** 均注最低勝率：與 prematchPrimaryMinProb 對齊（預設 0.58） */
  flatBetMinProb: parseFloat(process.env.FLAT_BET_MIN_PROB || '0.58'),
  flatBetMinEdgePct: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT || '3.0'),
  flatBetMinEdgePctTotals: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT_TOTALS || '4.5'),
  flatBetMinEdgePctProps: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT_PROPS || '4'),
  /** 均注僅 primary，且不含大小盤小球 */
  flatBetPrimaryOnly: process.env.FLAT_BET_PRIMARY_ONLY !== 'false',
  flatBetMinDataQuality: parseFloat(process.env.FLAT_BET_MIN_DATA_QUALITY || '0.65'),
  /** 負讓在未有方向切片 OOS 證據前只作 watch，不進均注 */
  flatBetAllowNegativeSpreads: process.env.FLAT_BET_ALLOW_NEGATIVE_SPREADS === 'true',
  /** 市場弱方需有可解釋的「模型不弱」證據才可進均注 */
  flatBetRequireContrarianSupport:
    process.env.FLAT_BET_REQUIRE_CONTRARIAN_SUPPORT !== 'false',
  contrarianMinWinProb: parseFloat(process.env.CONTRARIAN_MIN_WIN_PROB || '0.48'),
  contrarianMinDataQuality: parseFloat(process.env.CONTRARIAN_MIN_DATA_QUALITY || '0.80'),
  contrarianMinSupportSignals: parseInt(
    process.env.CONTRARIAN_MIN_SUPPORT_SIGNALS || '2',
    10
  ),
  /** actionable EV 額外加分封頂；避免宣稱 EV 最大者自動排第一 */
  actionableMaxEvBonus: parseFloat(process.env.ACTIONABLE_MAX_EV_BONUS || '6'),
  /** 串關錨腿：低水高勝率區間（可低於 1.75，僅作串關用，不進均注） */
  parlayAnchorMinOdds: parseFloat(process.env.PARLAY_ANCHOR_MIN_ODDS || '1.55'),
  parlayAnchorMaxOdds: parseFloat(process.env.PARLAY_ANCHOR_MAX_ODDS || '1.79'),
  parlayAnchorMinProb: parseFloat(process.env.PARLAY_ANCHOR_MIN_PROB || '0.60'),
  /** 滾球 v1.3：對齊初盤過濾 + 0-0／開局加嚴（命中率優先） */
  liveMinEvThreshold: parseFloat(process.env.LIVE_MIN_EV || '0.045'),
  liveH2hMinEdgePct: parseFloat(process.env.LIVE_H2H_MIN_EDGE || '4.5'),
  liveTotalsMinEdgePct: parseFloat(process.env.LIVE_TOTALS_MIN_EDGE || '5.5'),
  /** 滾球小球另加嚴（對齊初盤 totals under 思路） */
  liveUnderMinEdgePct: parseFloat(process.env.LIVE_UNDER_MIN_EDGE || '6.5'),
  liveMaxModelEdgePct: parseFloat(process.env.LIVE_MAX_MODEL_EDGE || '0.045'),
  liveEnableTotals: process.env.LIVE_ENABLE_TOTALS !== 'false',
  /** 滾球每場最多推薦條數（膠著時優先大小，避免同場 h2h+小 重複） */
  maxLivePicksPerGame: parseInt(process.env.MAX_LIVE_PICKS_PER_GAME || '1', 10),
  /**
   * 開局凍結：已進行局數低於此不推（約第 4 局初 = 3.0）
   * 避免 0-0／前段把初盤當滾球推
   */
  liveMinInningsPlayed: parseFloat(process.env.LIVE_MIN_INNINGS_PLAYED || '3.0'),
  /** 仍為 0-0 時，需打到此局數才允許任何滾球推薦 */
  liveZeroZeroMinInning: parseFloat(process.env.LIVE_ZERO_ZERO_MIN_INNING || '4.0'),
  /** 平手時獨贏至少進行到此局數才允許（否則噪音極大） */
  liveTiedH2hMinInning: parseFloat(process.env.LIVE_TIED_H2H_MIN_INNING || '5'),
  /** 開局前段（局數 < 此值）推小球時，預估終場須低於盤口至少此差距 */
  liveEarlyUnderMaxInning: parseFloat(process.env.LIVE_EARLY_UNDER_MAX_INNING || '5'),
  liveEarlyUnderMinGap: parseFloat(process.env.LIVE_EARLY_UNDER_MIN_GAP || '1.25'),
  /** 滾球是否尊重初盤立場（禁止早段翻案） */
  liveRespectPrematch: process.env.LIVE_RESPECT_PREMATCH !== 'false',
  livePrematchGuardMaxInning: parseFloat(process.env.LIVE_PREMATCH_GUARD_MAX_INNING || '6'),
  livePrematchGuardMaxMargin: parseFloat(process.env.LIVE_PREMATCH_GUARD_MAX_MARGIN || '1'),
  /** 真實概率低於此不得 primary / 「強烈」 */
  liveStrongProbFloor: parseFloat(process.env.LIVE_STRONG_PROB || '0.65'),
  liveWatchOnlyBelowProb: parseFloat(process.env.LIVE_WATCH_ONLY_BELOW || '0.65'),
  liveMinRecommendProb: parseFloat(process.env.LIVE_MIN_RECOMMEND_PROB || '0.56'),
  /** 滾球獨贏另加一層勝率門檻（平手開局 54% 級別不推） */
  liveH2hMinRecommendProb: parseFloat(process.env.LIVE_H2H_MIN_PROB || '0.60'),
  /** 模型比市場樂觀超過此值 → 拒絕（防硬剛莊家） */
  liveMaxMarketProbGap: parseFloat(process.env.LIVE_MAX_MARKET_GAP || '0.12'),
  liveMinDataQuality: parseFloat(process.env.LIVE_MIN_DATA_QUALITY || '0.55'),
  /** 接近局（平手/差1）主場殘差加成 */
  liveCloseGameHomeBoost: parseFloat(process.env.LIVE_CLOSE_HOME_BOOST || '0.055'),
  /** 一邊倒降速 */
  liveBlowoutMarginSoft: parseFloat(process.env.LIVE_BLOWOUT_MARGIN_SOFT || '4'),
  liveBlowoutMarginHard: parseFloat(process.env.LIVE_BLOWOUT_MARGIN_HARD || '6'),
  liveBlowoutScoreFactorSoft: parseFloat(process.env.LIVE_BLOWOUT_SOFT || '0.78'),
  liveBlowoutScoreFactorHard: parseFloat(process.env.LIVE_BLOWOUT_HARD || '0.58'),
  liveLateInningFactor6: parseFloat(process.env.LIVE_LATE_INNING_6 || '0.85'),
  liveLateInningFactor7: parseFloat(process.env.LIVE_LATE_INNING_7 || '0.72'),
  liveBlowoutOverExtraEdge: parseFloat(process.env.LIVE_BLOWOUT_OVER_EXTRA_EDGE || '5'),
  /** 滾球注碼更保守 */
  liveStakeHaircut: parseFloat(process.env.LIVE_STAKE_HAIRCUT || '0.7'),
  liveMaxStake: parseFloat(process.env.LIVE_MAX_STAKE || '8'),
  /** 滾球最低賠率：低於此直接不推（避開 1.05～1.20 鎖死熱門） */
  liveMinOdds: parseFloat(process.env.LIVE_MIN_ODDS || '1.55'),
  /** 低於此不得主推，僅觀察且加砍注 */
  livePrimaryMinOdds: parseFloat(process.env.LIVE_PRIMARY_MIN_ODDS || '1.70'),
  /** 低水區間額外 EV 門檻（賠率越低要求越高） */
  liveLowOddsExtraEv: parseFloat(process.env.LIVE_LOW_ODDS_EXTRA_EV || '0.04'),
  /** 前端滾球面板自動刷新間隔（分鐘，0=關閉） */
  livePollMinutes: parseFloat(process.env.LIVE_POLL_MINUTES || '5'),
};

export const LEAGUES = {
  MLB: {
    key: 'baseball_mlb',
    name: 'MLB 美職',
    sportId: 1,
    region: 'us',
  },
  NPB: {
    key: 'baseball_npb',
    name: 'NPB 日職',
    sportId: null,
    region: 'us',
  },
  KBO: {
    key: 'baseball_kbo',
    name: 'KBO 韓職',
    sportId: null,
    region: 'us',
  },
};

export const BASEBALL_LEAGUE_CODES = Object.keys(LEAGUES);
export const BASEBALL_LEAGUE_SQL = BASEBALL_LEAGUE_CODES.map((c) => `'${c}'`).join(',');
