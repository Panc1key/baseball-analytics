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
  maxParlayLegs: parseInt(process.env.MAX_PARLAY_LEGS || '12', 10),
  flatBetUsd: parseFloat(process.env.FLAT_BET_USD || '2'),
  parlayBetUsd: parseFloat(process.env.PARLAY_BET_USD || '1'),
  syncCron: process.env.SYNC_CRON || '0 8,14,20 * * *',
  staleDataHours: parseFloat(process.env.STALE_DATA_HOURS || '3'),
  recommendPrimaryScore: parseFloat(process.env.RECOMMEND_PRIMARY_SCORE || '65'),
  recommendWatchScore: parseFloat(process.env.RECOMMEND_WATCH_SCORE || '50'),
  maxPicksPerGame: parseInt(process.env.MAX_PICKS_PER_GAME || '5', 10),
  enablePlayerProps: process.env.ENABLE_PLAYER_PROPS !== 'false',
  maxPropGames: parseInt(process.env.MAX_PROP_GAMES || '6', 10),
  minParlayLegOdds: parseFloat(process.env.MIN_PARLAY_LEG_ODDS || '1.4'),
  /** 模型勝率最多可高於市場隱含的概率點數（0.08 = 8%） */
  maxModelEdgePct: parseFloat(process.env.MAX_MODEL_EDGE_PCT || '0.08'),
  /** 串關每腿最低 EV（與單場門檻一致） */
  parlayMinLegEv: parseFloat(process.env.PARLAY_MIN_LEG_EV || '0.03'),
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
