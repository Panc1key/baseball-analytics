/**
 * 足球分析模組配置（世界盃 → 五大聯盟可擴展）
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

export const footballConfig = {
  apiFootballKey: process.env.API_FOOTBALL_KEY || '',
  minEvThreshold: parseFloat(process.env.FOOTBALL_MIN_EV || '0.03'),
  minConfidence: parseFloat(process.env.FOOTBALL_MIN_CONFIDENCE || '0.06'),
  recommendPrimaryScore: parseFloat(process.env.FOOTBALL_PRIMARY_SCORE || '62'),
  recommendWatchScore: parseFloat(process.env.FOOTBALL_WATCH_SCORE || '48'),
  maxPicksPerGame: parseInt(process.env.FOOTBALL_MAX_PICKS || '6', 10),
  maxPropGames: parseInt(process.env.FOOTBALL_MAX_PROP_GAMES || '8', 10),
  /** 足球球員盤極耗 Odds API（逐場 event-odds）；額度不足時請保持 false */
  enablePlayerProps: process.env.FOOTBALL_ENABLE_PROPS === 'true',
  maxModelEdgePct: parseFloat(process.env.FOOTBALL_MAX_MODEL_EDGE || '0.10'),
  marketBlendFull: parseFloat(process.env.FOOTBALL_MARKET_BLEND_FULL || '0.35'),
  marketBlendLite: parseFloat(process.env.FOOTBALL_MARKET_BLEND_LITE || '0.50'),
  h2hMinEdgePct: parseFloat(process.env.FOOTBALL_H2H_MIN_EDGE || '1.2'),
  totalsMinEdgePct: parseFloat(process.env.FOOTBALL_TOTALS_MIN_EDGE || '1.8'),
  totalsMinContrarianEdgePct: parseFloat(process.env.FOOTBALL_TOTALS_MIN_CONTRARIAN || '4.5'),
  totalsMinLineGap: parseFloat(process.env.FOOTBALL_TOTALS_MIN_LINE_GAP || '0.2'),
  totalsMinModelMarketGap: parseFloat(process.env.FOOTBALL_TOTALS_MIN_MODEL_GAP || '0.15'),
  flatBetMinOdds: parseFloat(process.env.FOOTBALL_FLAT_MIN_ODDS || '1.65'),
  flatBetMinProb: parseFloat(process.env.FOOTBALL_FLAT_MIN_PROB || '0.50'),
  parlayAnchorMinOdds: parseFloat(process.env.FOOTBALL_ANCHOR_MIN_ODDS || '1.45'),
  parlayAnchorMaxOdds: parseFloat(process.env.FOOTBALL_ANCHOR_MAX_ODDS || '1.85'),
  parlayAnchorMinProb: parseFloat(process.env.FOOTBALL_ANCHOR_MIN_PROB || '0.56'),
  /** 世界盃多為中立場，主場優勢較低（以勝率尺度表達，再映到進球加成） */
  homeAdvantageNeutral: parseFloat(process.env.FOOTBALL_HOME_ADV_NEUTRAL || '0.015'),
  homeAdvantageNormal: parseFloat(process.env.FOOTBALL_HOME_ADV_NORMAL || '0.055'),
  /** Dixon–Coles ρ：負值提高 0-0/1-1 相關（文獻常見 -0.03~-0.13） */
  dixonColesRho: parseFloat(process.env.FOOTBALL_DC_RHO || '-0.08'),
  baseDrawRate: parseFloat(process.env.FOOTBALL_BASE_DRAW_RATE || '0.24'),
};

/** 聯盟定義：oddsKey 對應 The Odds API；apiFootballLeagueId 對應 API-Football */
export const FOOTBALL_LEAGUES = {
  WC: {
    code: 'WC',
    key: 'soccer_fifa_world_cup',
    name: '世界盃',
    region: 'us,eu',
    neutralVenue: true,
    apiFootballLeagueId: 1,
    season: 2026,
  },
  MLS: {
    code: 'MLS',
    key: 'soccer_usa_mls',
    name: 'MLS 美職足',
    region: 'us',
    neutralVenue: false,
    apiFootballLeagueId: 253,
    season: 2026,
  },
  LIGAMX: {
    code: 'LIGAMX',
    key: 'soccer_mexico_ligamx',
    name: '墨超',
    region: 'us',
    neutralVenue: false,
    apiFootballLeagueId: 262,
    season: 2026,
  },
  KLEAGUE: {
    code: 'KLEAGUE',
    key: 'soccer_korea_kleague1',
    name: 'K聯賽',
    region: 'us,eu',
    neutralVenue: false,
    apiFootballLeagueId: 292,
    season: 2026,
  },
  // 預留五大聯盟（啟用時取消註解）
  // EPL: { code: 'EPL', key: 'soccer_epl', name: '英超', region: 'uk,eu', neutralVenue: false, apiFootballLeagueId: 39, season: 2025 },
};

export const FOOTBALL_LEAGUE_CODES = Object.keys(FOOTBALL_LEAGUES);

export const SOCCER_BULK_MARKETS = 'h2h,spreads,totals';
export const SOCCER_PROP_MARKETS = [
  'player_goal_scorer_anytime',
  'player_first_goal_scorer',
  'player_shots_on_target',
  'player_shots',
  'player_assists',
  'player_to_receive_card',
];

export const SOCCER_PROP_LABELS = {
  player_goal_scorer_anytime: '任意時間進球',
  player_first_goal_scorer: '首個進球',
  player_shots_on_target: '射正',
  player_shots: '射門',
  player_assists: '助攻',
  player_to_receive_card: '吃牌',
};
