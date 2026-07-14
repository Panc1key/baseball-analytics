/**
 * 網球初盤分析配置（ATP / WTA 賽事動態發現）
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

export const tennisConfig = {
  minEvThreshold: parseFloat(process.env.TENNIS_MIN_EV || '0.03'),
  minConfidence: parseFloat(process.env.TENNIS_MIN_CONFIDENCE || '0.08'),
  recommendPrimaryScore: parseFloat(process.env.TENNIS_PRIMARY_SCORE || '62'),
  recommendWatchScore: parseFloat(process.env.TENNIS_WATCH_SCORE || '48'),
  maxPicksPerGame: parseInt(process.env.TENNIS_MAX_PICKS || '3', 10),
  maxModelEdgePct: parseFloat(process.env.TENNIS_MAX_MODEL_EDGE || '0.09'),
  marketBlendFull: parseFloat(process.env.TENNIS_MARKET_BLEND_FULL || '0.4'),
  marketBlendLite: parseFloat(process.env.TENNIS_MARKET_BLEND_LITE || '0.6'),
  h2hMinEdgePct: parseFloat(process.env.TENNIS_H2H_MIN_EDGE || '1.5'),
  spreadsMinEdgePct: parseFloat(process.env.TENNIS_SPREADS_MIN_EDGE || '2.0'),
  totalsMinEdgePct: parseFloat(process.env.TENNIS_TOTALS_MIN_EDGE || '2.0'),
  totalsMinContrarianEdgePct: parseFloat(process.env.TENNIS_TOTALS_MIN_CONTRARIAN || '5'),
  totalsMinLineGap: parseFloat(process.env.TENNIS_TOTALS_MIN_LINE_GAP || '1.0'),
  totalsMinModelMarketGap: parseFloat(process.env.TENNIS_TOTALS_MIN_MODEL_GAP || '0.8'),
  flatBetMinOdds: parseFloat(process.env.TENNIS_FLAT_MIN_ODDS || '1.65'),
  flatBetMinProb: parseFloat(process.env.TENNIS_FLAT_MIN_PROB || '0.52'),
  parlayAnchorMinOdds: parseFloat(process.env.TENNIS_ANCHOR_MIN_ODDS || '1.40'),
  parlayAnchorMaxOdds: parseFloat(process.env.TENNIS_ANCHOR_MAX_ODDS || '1.85'),
  parlayAnchorMinProb: parseFloat(process.env.TENNIS_ANCHOR_MIN_PROB || '0.56'),
  /** 無真實主場；首發選手略微加成（盤口 home_team） */
  homePseudoAdv: parseFloat(process.env.TENNIS_HOME_PSEUDO_ADV || '0.01'),
  spreadScale: parseFloat(process.env.TENNIS_SPREAD_SCALE || '4.5'),
  totalsScale: parseFloat(process.env.TENNIS_TOTALS_SCALE || '3.5'),
  /** BO3 預設總局數先驗 */
  avgGamesBo3: parseFloat(process.env.TENNIS_AVG_GAMES_BO3 || '22.5'),
  /** BO5（大滿貫男單）略高 */
  avgGamesBo5: parseFloat(process.env.TENNIS_AVG_GAMES_BO5 || '38'),
};

export const TENNIS_BULK_MARKETS = 'h2h,spreads,totals';

/** Odds key → 內部聯盟碼，例 tennis_atp_us_open → ATP_US_OPEN */
export function tennisLeagueCodeFromKey(sportKey) {
  return String(sportKey || '')
    .replace(/^tennis_/, '')
    .toUpperCase();
}

export function isTennisLeagueCode(code) {
  return /^(ATP|WTA)_/i.test(code || '');
}

export function isBestOf5Tournament(leagueCode) {
  const c = String(leagueCode || '').toUpperCase();
  return (
    c.includes('AUS_OPEN') ||
    c.includes('FRENCH_OPEN') ||
    c.includes('WIMBLEDON') ||
    c.includes('US_OPEN')
  ) && c.startsWith('ATP_');
}

/** SQL：網球聯盟碼（ATP_/WTA_） */
export const TENNIS_LEAGUE_SQL = `(league LIKE 'ATP_%' OR league LIKE 'WTA_%')`;
