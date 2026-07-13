import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

export const config = {
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
  recommendPrimaryScore: parseFloat(process.env.RECOMMEND_PRIMARY_SCORE || '65'),
  recommendWatchScore: parseFloat(process.env.RECOMMEND_WATCH_SCORE || '50'),
  maxPicksPerGame: parseInt(process.env.MAX_PICKS_PER_GAME || '3', 10),
  /** 同一場次最多均注腿數（不同盤口各一） */
  maxFlatBetsPerGame: parseInt(process.env.MAX_FLAT_BETS_PER_GAME || '2', 10),
  enablePlayerProps: process.env.ENABLE_PLAYER_PROPS === 'true',
  maxPropGames: parseInt(process.env.MAX_PROP_GAMES || '6', 10),
  minParlayLegOdds: parseFloat(process.env.MIN_PARLAY_LEG_ODDS || '1.4'),
  /** 模型勝率最多可高於市場隱含的概率點數（0.06 = 6%，降低幻覺） */
  maxModelEdgePct: parseFloat(process.env.MAX_MODEL_EDGE_PCT || '0.06'),
  /** 串關每腿最低 EV（與單場門檻一致） */
  parlayMinLegEv: parseFloat(process.env.PARLAY_MIN_LEG_EV || '0.03'),
  /** 獨贏：市場混合權重（數據完整時） */
  h2hMarketBlendMlbFull: parseFloat(process.env.H2H_MARKET_BLEND_MLB_FULL || '0.4'),
  h2hMarketBlendMlb: parseFloat(process.env.H2H_MARKET_BLEND_MLB || '0.45'),
  h2hMarketBlendMlbLite: parseFloat(process.env.H2H_MARKET_BLEND_MLB_LITE || '0.5'),
  h2hMarketBlendOther: parseFloat(process.env.H2H_MARKET_BLEND_OTHER || '0.55'),
  /** 獨贏推薦：模型與市場最小優勢（%） */
  h2hMinEdgePct: parseFloat(process.env.H2H_MIN_EDGE_PCT || '1.5'),
  /** 獨贏：避免 50/50 場次 */
  h2hMinConfidence: parseFloat(process.env.H2H_MIN_CONFIDENCE || '0.08'),
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
  /** 單場主推：大小盤評分折扣（避免大小霸佔主推） */
  totalsPrimaryScorePenalty: parseFloat(process.env.TOTALS_PRIMARY_SCORE_PENALTY || '15'),
  /** 均注精選：最低賠率（避開低水臭水，@1.75 損益平衡約 57%） */
  flatBetMinOdds: parseFloat(process.env.FLAT_BET_MIN_ODDS || '1.80'),
  flatBetMinProb: parseFloat(process.env.FLAT_BET_MIN_PROB || '0.58'),
  flatBetMinEdgePct: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT || '2.5'),
  flatBetMinEdgePctTotals: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT_TOTALS || '4'),
  flatBetMinEdgePctProps: parseFloat(process.env.FLAT_BET_MIN_EDGE_PCT_PROPS || '4'),
  /** 均注僅 primary，且不含大小盤 */
  flatBetPrimaryOnly: process.env.FLAT_BET_PRIMARY_ONLY !== 'false',
  flatBetMinDataQuality: parseFloat(process.env.FLAT_BET_MIN_DATA_QUALITY || '0.65'),
  /** 串關錨腿：低水高勝率區間 */
  parlayAnchorMinOdds: parseFloat(process.env.PARLAY_ANCHOR_MIN_ODDS || '1.55'),
  parlayAnchorMaxOdds: parseFloat(process.env.PARLAY_ANCHOR_MAX_ODDS || '1.79'),
  parlayAnchorMinProb: parseFloat(process.env.PARLAY_ANCHOR_MIN_PROB || '0.58'),
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
