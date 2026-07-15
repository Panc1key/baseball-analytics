import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

export const config = {
  modelVersion: process.env.MODEL_VERSION || 'baseball-v2.4.0',
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
  staleDataHours: parseFloat(process.env.STALE_DATA_HOURS || '3'),
  /** 已開賽但仍可推薦的滾球窗口（小時，MLB 一場約 3h） */
  liveGameGraceHours: parseFloat(process.env.LIVE_GAME_GRACE_HOURS || '6'),
  /** 初盤分析向前看多少小時（7天 = 168，支援按日 Slate） */
  upcomingGameHorizonHours: parseFloat(process.env.UPCOMING_GAME_HORIZON_HOURS || '168'),
  /** 前端按日 Slate 預設顯示天數 */
  slateDefaultDays: parseInt(process.env.SLATE_DEFAULT_DAYS || '7', 10),
  /** 推薦列表時區（香港 UTC+8） */
  displayTimezone: process.env.DISPLAY_TIMEZONE || 'Asia/Hong_Kong',
  recommendPrimaryScore: parseFloat(process.env.RECOMMEND_PRIMARY_SCORE || '65'),
  recommendWatchScore: parseFloat(process.env.RECOMMEND_WATCH_SCORE || '50'),
  maxPicksPerGame: parseInt(process.env.MAX_PICKS_PER_GAME || '3', 10),
  /** 同一場次最多均注腿數（不同盤口各一） */
  maxFlatBetsPerGame: parseInt(process.env.MAX_FLAT_BETS_PER_GAME || '1', 10),
  enablePlayerProps: process.env.ENABLE_PLAYER_PROPS === 'true',
  maxPropGames: parseInt(process.env.MAX_PROP_GAMES || '6', 10),
  minParlayLegOdds: parseFloat(process.env.MIN_PARLAY_LEG_ODDS || '1.4'),
  /** 模型勝率最多可高於市場隱含的概率點數（0.06 = 6%） */
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
  /** NPB 有 Yahoo 順位時仍須偏貼市場（無先發，賽季隊力資訊量遠低於盤口） */
  h2hMarketBlendNpbFull: parseFloat(process.env.H2H_MARKET_BLEND_NPB_FULL || '0.52'),
  /** 得分模型與 Log5 混合（NPB 無先發，權重低于 MLB） */
  scoreModelBlendNpb: parseFloat(process.env.SCORE_MODEL_BLEND_NPB || '0.28'),
  /** NPB/KBO 獨贏：最低領先第二方差距 */
  h2hMinProbGapNpb: parseFloat(process.env.H2H_MIN_PROB_GAP_NPB || '0.06'),
  /** NPB/KBO 獨贏：最低熱門勝率 */
  h2hMinFavoriteProbNpb: parseFloat(process.env.H2H_MIN_FAV_NPB || '0.56'),
  /** NPB/KBO 獨贏最小優勢%（比 MLB 嚴） */
  h2hMinEdgePctNpb: parseFloat(process.env.H2H_MIN_EDGE_PCT_NPB || '3.0'),
  /** NPB 均注最低勝率 / 優勢（勝率優先） */
  flatBetMinProbNpb: parseFloat(process.env.FLAT_BET_MIN_PROB_NPB || '0.60'),
  flatBetMinEdgePctNpb: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT_NPB || '3.5'),
  flatBetMinDataQualityNpb: parseFloat(process.env.FLAT_BET_MIN_DQ_NPB || '0.70'),
  /** +1.5 進均注的最低蓋盤率 */
  flatBetPlus15MinCover: parseFloat(process.env.FLAT_BET_PLUS15_MIN_COVER || '0.62'),
  /** 初盤推薦最低賠率（避免 1.51 短水受讓當「有用推薦」） */
  prematchMinOdds: parseFloat(process.env.PREMATCH_MIN_ODDS || '1.70'),
  /** 初盤主推最低賠率 */
  prematchPrimaryMinOdds: parseFloat(process.env.PREMATCH_PRIMARY_MIN_ODDS || '1.75'),
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
  /** 讓分 +1.5 主推評分折扣（避免受让霸佔主推） */
  spreadsPlus15PrimaryPenalty: parseFloat(process.env.SPREADS_PLUS15_PRIMARY_PENALTY || '12'),
  /** 讓分：受让最低獨贏勝率 */
  spreadsMinDogWinProb: parseFloat(process.env.SPREADS_MIN_DOG_WIN_PROB || '0.47'),
  /** 讓分：模型看衰對手時最大可接受差距 */
  spreadsMaxModelDeficit: parseFloat(process.env.SPREADS_MAX_MODEL_DEFICIT || '0.03'),
  /** 讓分 +1.5：得分模型預期分差低於此值禁止（客隊視角） */
  spreadsMinExpectedMargin: parseFloat(process.env.SPREADS_MIN_EXPECTED_MARGIN || '-0.35'),
  /** 讓分：先發劣勢超過此值禁止受让 */
  spreadsMaxPitcherDeficit: parseFloat(process.env.SPREADS_MAX_PITCHER_DEFICIT || '0.025'),
  /** 得分模型混合權重（有完整 MLB 數據 + 先發） */
  scoreModelBlendMlbFull: parseFloat(process.env.SCORE_MODEL_BLEND_MLB_FULL || '0.55'),
  /** 得分模型混合權重（僅戰績） */
  scoreModelBlendMlb: parseFloat(process.env.SCORE_MODEL_BLEND_MLB || '0.45'),
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
  totalsMarketBlendNpbFull: parseFloat(process.env.TOTALS_MARKET_BLEND_NPB_FULL || '0.5'),
  /** 大小盤推薦門檻 */
  totalsMinEdgePct: parseFloat(process.env.TOTALS_MIN_EDGE_PCT || '2'),
  totalsMinContrarianEdgePct: parseFloat(process.env.TOTALS_MIN_CONTRARIAN_EDGE_PCT || '5'),
  totalsMinLineGap: parseFloat(process.env.TOTALS_MIN_LINE_GAP || '0.4'),
  totalsMinModelMarketGap: parseFloat(process.env.TOTALS_MIN_MODEL_MARKET_GAP || '0.35'),
  totalsMaxModelMarketGap: parseFloat(process.env.TOTALS_MAX_MODEL_MARKET_GAP || '1.2'),
  totalsMinEv: parseFloat(process.env.TOTALS_MIN_EV || '0.03'),
  /** 單場主推：大小盤評分折扣（避免大小霸佔主推） */
  totalsPrimaryScorePenalty: parseFloat(process.env.TOTALS_PRIMARY_SCORE_PENALTY || '15'),
  /** 均注精選：最低賠率（避開低水臭水） */
  flatBetMinOdds: parseFloat(process.env.FLAT_BET_MIN_ODDS || '1.80'),
  flatBetMinProb: parseFloat(process.env.FLAT_BET_MIN_PROB || '0.58'),
  flatBetMinEdgePct: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT || '2.5'),
  flatBetMinEdgePctTotals: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT_TOTALS || '4'),
  flatBetMinEdgePctProps: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT_PROPS || '4'),
  /** 均注僅 primary，且不含大小盤小球 */
  flatBetPrimaryOnly: process.env.FLAT_BET_PRIMARY_ONLY !== 'false',
  flatBetMinDataQuality: parseFloat(process.env.FLAT_BET_MIN_DATA_QUALITY || '0.65'),
  /** 串關錨腿：低水高勝率區間 */
  parlayAnchorMinOdds: parseFloat(process.env.PARLAY_ANCHOR_MIN_ODDS || '1.55'),
  parlayAnchorMaxOdds: parseFloat(process.env.PARLAY_ANCHOR_MAX_ODDS || '1.79'),
  parlayAnchorMinProb: parseFloat(process.env.PARLAY_ANCHOR_MIN_PROB || '0.58'),
  /** 滾球 v1.1：對照事故總結加嚴 */
  liveMinEvThreshold: parseFloat(process.env.LIVE_MIN_EV || '0.035'),
  liveH2hMinEdgePct: parseFloat(process.env.LIVE_H2H_MIN_EDGE || '2.5'),
  liveTotalsMinEdgePct: parseFloat(process.env.LIVE_TOTALS_MIN_EDGE || '4'),
  liveMaxModelEdgePct: parseFloat(process.env.LIVE_MAX_MODEL_EDGE || '0.045'),
  liveEnableTotals: process.env.LIVE_ENABLE_TOTALS !== 'false',
  /** 真實概率低於此不得 primary / 「強烈」 */
  liveStrongProbFloor: parseFloat(process.env.LIVE_STRONG_PROB || '0.65'),
  liveWatchOnlyBelowProb: parseFloat(process.env.LIVE_WATCH_ONLY_BELOW || '0.65'),
  liveMinRecommendProb: parseFloat(process.env.LIVE_MIN_RECOMMEND_PROB || '0.52'),
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
