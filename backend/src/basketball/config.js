/**
 * 籃球初盤分析配置（NBA / WNBA / 夏季聯賽）
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

export const basketballConfig = {
  minEvThreshold: parseFloat(process.env.BASKETBALL_MIN_EV || '0.03'),
  minConfidence: parseFloat(process.env.BASKETBALL_MIN_CONFIDENCE || '0.08'),
  recommendPrimaryScore: parseFloat(process.env.BASKETBALL_PRIMARY_SCORE || '62'),
  recommendWatchScore: parseFloat(process.env.BASKETBALL_WATCH_SCORE || '48'),
  maxPicksPerGame: parseInt(process.env.BASKETBALL_MAX_PICKS || '3', 10),
  maxModelEdgePct: parseFloat(process.env.BASKETBALL_MAX_MODEL_EDGE || '0.08'),
  marketBlendFull: parseFloat(process.env.BASKETBALL_MARKET_BLEND_FULL || '0.4'),
  marketBlendLite: parseFloat(process.env.BASKETBALL_MARKET_BLEND_LITE || '0.55'),
  h2hMinEdgePct: parseFloat(process.env.BASKETBALL_H2H_MIN_EDGE || '1.5'),
  spreadsMinEdgePct: parseFloat(process.env.BASKETBALL_SPREADS_MIN_EDGE || '2.0'),
  totalsMinEdgePct: parseFloat(process.env.BASKETBALL_TOTALS_MIN_EDGE || '2.0'),
  totalsMinContrarianEdgePct: parseFloat(process.env.BASKETBALL_TOTALS_MIN_CONTRARIAN || '5'),
  totalsMinLineGap: parseFloat(process.env.BASKETBALL_TOTALS_MIN_LINE_GAP || '2.0'),
  totalsMinModelMarketGap: parseFloat(process.env.BASKETBALL_TOTALS_MIN_MODEL_GAP || '1.5'),
  flatBetMinOdds: parseFloat(process.env.BASKETBALL_FLAT_MIN_ODDS || '1.70'),
  flatBetMinProb: parseFloat(process.env.BASKETBALL_FLAT_MIN_PROB || '0.52'),
  parlayAnchorMinOdds: parseFloat(process.env.BASKETBALL_ANCHOR_MIN_ODDS || '1.45'),
  parlayAnchorMaxOdds: parseFloat(process.env.BASKETBALL_ANCHOR_MAX_ODDS || '1.90'),
  parlayAnchorMinProb: parseFloat(process.env.BASKETBALL_ANCHOR_MIN_PROB || '0.55'),
/** 主場分數優勢（NBA 約 2.5–3.5；文獻常用 ~3） */
  homeCourtPoints: parseFloat(process.env.BASKETBALL_HOME_COURT_PTS || '3.0'),
  /** 淨勝分常態標準差（NBA 歷史約 11–12） */
  marginSigma: parseFloat(process.env.BASKETBALL_MARGIN_SIGMA || '11.5'),
  /** 總分常態標準差（略寬於淨勝分） */
  totalSigma: parseFloat(process.env.BASKETBALL_TOTAL_SIGMA || '14'),
  /** @deprecated 改用 marginSigma 常態；保留相容 */
  homeAdvantage: parseFloat(process.env.BASKETBALL_HOME_ADV || '0.04'),
  spreadScale: parseFloat(process.env.BASKETBALL_SPREAD_SCALE || '9'),
  totalsScale: parseFloat(process.env.BASKETBALL_TOTALS_SCALE || '8'),
};

/** 聯盟平均總分（供 totals 先驗） */
export const BASKETBALL_LEAGUE_AVG_TOTAL = {
  NBA: 224,
  WNBA: 164,
  NBA_SUMMER: 190,
  DEFAULT: 210,
};

export const BASKETBALL_LEAGUES = {
  NBA: {
    code: 'NBA',
    key: 'basketball_nba',
    name: 'NBA',
    region: 'us',
  },
  WNBA: {
    code: 'WNBA',
    key: 'basketball_wnba',
    name: 'WNBA',
    region: 'us',
  },
  NBA_SUMMER: {
    code: 'NBA_SUMMER',
    key: 'basketball_nba_summer_league',
    name: 'NBA 夏季聯賽',
    region: 'us',
  },
};

export const BASKETBALL_LEAGUE_CODES = Object.keys(BASKETBALL_LEAGUES);
export const BASKETBALL_BULK_MARKETS = 'h2h,spreads,totals';
