/**
 * MLB 賽前真實資料管線。
 *
 * 推理骨架已凍結（見 MlbInferenceFreeze.js / docs/expansion/MLB-INFERENCE-FREEZE.md）：
 *   predictMlbGameRuns →（鎖定 B 疊加 residual+shrink）→ 比分分布市場 → 獨贏分類。
 * 禁止改接 predictMlbGameRunsWithRegime 或 legacy TeamAnalyzer 作為正式輸出。
 *
 * 此模組刻意不讀取舊 recommendations、tier、flat_bet 或建議注碼。
 * 它只保存可追溯的賽前事實、資料缺口與研究用模型輸出；在策略通過
 * 樣本外驗證前，任何場次都不能成為可實投訊號。
 */
import db from '../db/database.js';
import { MLB_INFERENCE_FREEZE, describeMlbInferenceFreeze } from './MlbInferenceFreeze.js';
import {
  getMlbScheduleAround,
  getProbablePitchers,
  getVenueName,
  matchMlbOfficialGame,
  getMlbGameBoxscore,
  getMlbTeamSchedule,
  getMlbVenue,
  getTeamActiveRoster,
  getTeamInjuryList,
  getMlbOfficialPregameTeamFeatures,
  getMlbPitcherPregameFeaturesFromGameLog,
  getMlbPitcherRecentStartFeatures,
  buildMlbPregamePlatoonBlock,
} from './MlbStatsService.js';
import { randomUUID } from 'crypto';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import { config } from '../config.js';

/**
 * 鎖定 B 放出時窗：開賽前 (0, N] 小時才准進「可看選邊」／紙上晉升。
 * N=0 表示關閉時窗（一過門檻就放）。
 */
export function isWithinLockedBReleaseWindow(commenceTime, nowMs = Date.now()) {
  const hours = Number(config.mlbLockedBReleaseHoursBefore);
  if (!Number.isFinite(hours) || hours <= 0) return true;
  const commenceMs = Date.parse(commenceTime);
  if (!Number.isFinite(commenceMs)) return false;
  const hoursUntil = (commenceMs - nowMs) / 3600000;
  return hoursUntil > 0 && hoursUntil <= hours;
}

export function lockedBReleaseWindowMeta(commenceTime, nowMs = Date.now()) {
  const hours = Number(config.mlbLockedBReleaseHoursBefore) || 0;
  const commenceMs = Date.parse(commenceTime);
  const hoursUntil = Number.isFinite(commenceMs)
    ? (commenceMs - nowMs) / 3600000
    : null;
  const released = isWithinLockedBReleaseWindow(commenceTime, nowMs);
  return {
    enabled: hours > 0,
    releaseHoursBefore: hours,
    hoursUntilCommence:
      hoursUntil == null ? null : Number(hoursUntil.toFixed(2)),
    released,
    holdReason: released
      ? null
      : hoursUntil != null && hoursUntil > hours
        ? `hold_until_t_minus_${hours}h`
        : hoursUntil != null && hoursUntil <= 0
          ? 'already_started'
          : 'commence_time_invalid',
  };
}
import { resolveMlbParkFactor } from '../data/parkFactors.js';
import { resolveMlbVenueMeta } from '../data/venueMeta.js';
import { getExternalLineupEvidence } from './ExternalPrematchSnapshotService.js';
import {
  buildMlbRecentBoxscoreFeaturesAt,
  buildMlbTeamFeatureStateAt,
  composeMlbFeatureVector,
  getLatestMlbBaselineModel,
  predictMlbBaseline,
} from './MlbHistoricalBaseline.js';
import {
  attachMlbRegimeMarketPlan,
  classifyMlbMoneylineCandidate,
  getLatestMlbExpectedRunsValidation,
  MLB_EXPECTED_RUNS_MODEL_VERSION,
  predictMlbGameRuns,
} from './MlbExpectedRunsModel.js';
import { applyFormalLockedBResidual } from './MlbFrozenBShadow.js';
import {
  analyzeGamePitcherInjuryIntel,
  summarizePitcherInjuryIntelEvidence,
} from './PitcherInjuryIntelService.js';
import {
  fetchAndCacheMlbGameWeather,
} from './MlbGameWeatherService.js';
import {
  syncPitProbableIntoFeatureRows,
} from './MlbHighWeightFeatureSync.js';
import {
  recordMlbProbableStarterSnapshot,
  resolveMlbProbableStarterSnapshot,
} from './MlbProbableStarterService.js';
import {
  attachDailyResearchRanks,
  selectExpectedRunsResearchDirection,
  selectResearchDirection,
} from './MlbResearchRanker.js';
import { resolvePitOdds } from './PitOddsService.js';
import { buildPregameRegimeSignals } from './MlbGameRegimeService.js';
import {
  buildDataReadiness,
  getMandatoryEvidenceKeys,
  isEvidenceReadyForRecommend,
} from './MlbEvidenceCatalog.js';
import {
  MLB_TOTALS_SATELLITE_SPEC,
  MLB_TOTALS_SATELLITE_UNDER_ONLY_SPEC,
  MLB_TOTALS_SATELLITE_HYBRID_SPEC,
  bestFairTotals,
  classifyMlbTotalsSatelliteCandidate,
  classifyMlbTotalsHybridCandidate,
  selectDailyTotalsSatellitePicks,
} from './MlbTotalsSatellite.js';
import {
  freezeMlbTotalsHybridOnRelease,
  formatFrozenHybridPick,
  getMlbTotalsHybridFreeze,
  suppressMlbTotalsHybridFreezeForMoneyline,
  MLB_TOTALS_HYBRID_FREEZE_SPEC,
} from './MlbTotalsHybridFreeze.js';
import {
  createPaperBetFromCandidate,
  hasMlbPaperMoneylineBet,
  listPendingMlbPaperMoneylineBets,
} from './MlbPaperLedger.js';
import {
  MLB_LOCKED_B_PACKAGE,
  buildLockedBPackageSnapshot,
} from './MlbLockedBPackage.js';
import {
  buildHighEvShrinkShadowSlate,
} from './MlbHighEvShrinkShadow.js';
import {
  buildWinrateStrongHomeShadowSlate,
} from './MlbWinrateStrongHomeShadow.js';
import {
  buildDirectionBlendDisagreeShadowSlate,
} from './MlbDirectionBlendDisagreeShadow.js';
import {
  applyTotalsFragileUnderShadow,
  MLB_TOTALS_FRAGILE_UNDER_SPEC,
  resolveTotalsFragileUnderMode,
} from './MlbTotalsFragileUnderShadow.js';
import {
  buildSurgicalAwayStrongEvShadowSlate,
} from './MlbSurgicalAwayStrongEvShadow.js';
import {
  buildSurgicalAwayR1MidoddsShadowSlate,
} from './MlbSurgicalAwayR1MidoddsShadow.js';
import {
  applyTotalsUnderPitcherShadow,
  applyTotalsUnderPitcherToCandidate,
} from './MlbTotalsUnderPitcherShadow.js';

const STRATEGY_VERSION = 'mlb-expected-runs-rank-v2';
const EVIDENCE_VERSION = 'mlb-prematch-evidence-v5';

function resolveFormalModelVersion(validation = getLatestMlbExpectedRunsValidation()) {
  return validation?.modelVersion || MLB_EXPECTED_RUNS_MODEL_VERSION;
}

function nowIso() {
  return new Date().toISOString();
}

function injuryRosterSummary(roster = []) {
  if (!roster.length) return '0 人';
  const names = roster
    .slice(0, 8)
    .map((entry) => `${entry.name}${entry.status ? `（${entry.status}）` : ''}`)
    .join('、');
  const remaining = roster.length > 8 ? ` 等 ${roster.length} 人` : '';
  return `${names}${remaining}`;
}

function evidence(key, status, {
  summary,
  source = null,
  sourceRef = null,
  values = null,
  capturedAt = nowIso(),
  validUntil = null,
  reason = null,
  usedInModel = false,
} = {}) {
  return {
    key,
    status,
    summary: summary || '',
    source,
    sourceRef,
    values,
    capturedAt,
    validUntil,
    reason,
    usedInModel,
  };
}

function stateScore(status) {
  if (status === 'verified') return 1;
  if (status === 'partial') return 0.5;
  return 0;
}

function formatRate(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '?';
}

function recordLabel(record) {
  if (!record) return '?';
  return `${record.wins}-${record.losses}｜主 ${record.homeWins}-${record.homeLosses}` +
    `／客 ${record.awayWins}-${record.awayLosses}｜近10 ${record.last10Wins}-${record.last10Losses}`;
}

export function detectStarterInjuryConflicts(pitchers, homeInjuries, awayInjuries) {
  return [
    ...(pitchers.home?.id &&
    (homeInjuries?.roster || []).some((entry) => entry.id === pitchers.home.id)
      ? [{ side: 'home', pitcher: pitchers.home, source: 'official_il' }]
      : []),
    ...(pitchers.away?.id &&
    (awayInjuries?.roster || []).some((entry) => entry.id === pitchers.away.id)
      ? [{ side: 'away', pitcher: pitchers.away, source: 'official_il' }]
      : []),
  ];
}

export function calculateCompleteness(items) {
  return buildDataReadiness(items).score01;
}

/**
 * 從同一 bookmaker 取得雙邊 h2h，避免把不同莊家的最佳價格拼成假去水概率。
 * 回傳另附 h2hBookCount（完整雙邊 h2h 的庄數），供多莊共識閘使用。
 */
export function bestFairH2h(bookmakers, homeTeam, awayTeam) {
  let selected = null;
  let h2hBookCount = 0;
  for (const book of bookmakers) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    const home = market?.outcomes?.find((o) => o.name === homeTeam);
    const away = market?.outcomes?.find((o) => o.name === awayTeam);
    if (!home?.price || !away?.price) continue;
    const homeImplied = decimalToImpliedProb(home.price);
    const awayImplied = decimalToImpliedProb(away.price);
    if (!homeImplied || !awayImplied) continue;
    h2hBookCount += 1;
    const margin = homeImplied + awayImplied - 1;
    if (!selected || margin < selected.margin) {
      const fair = removeVig(homeImplied, awayImplied);
      selected = {
        bookmaker: book.title || book.key || 'unknown',
        homeOdds: Number(home.price),
        awayOdds: Number(away.price),
        homeProb: fair.fairA,
        awayProb: fair.fairB,
        margin,
      };
    }
  }
  if (!selected) return null;
  return { ...selected, h2hBookCount };
}

function dateOffset(iso, days) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function coordinateFromVenue(venue) {
  const location = venue?.location || {};
  const coords = venue?.location?.defaultCoordinates || venue?.location?.coordinates || {};
  const latitude = Number(coords.latitude ?? location.latitude);
  const longitude = Number(coords.longitude ?? location.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

async function collectWeather(venue, commenceTime, {
  gameId = null,
  venueName = null,
  homeTeam = null,
} = {}) {
  const fromApiVenue = coordinateFromVenue(venue);
  const meta = resolveMlbVenueMeta({ venueName, homeTeam });
  const weather = await fetchAndCacheMlbGameWeather({
    gameId,
    commenceTime,
    venueName: venueName || meta?.venueName,
    homeTeam,
  });
  if (!weather) return null;
  if (weather.source === 'fallback_uncached' || weather.source === 'fallback_missing_venue') {
    return null;
  }
  return {
    coordinates: weather.coordinates || fromApiVenue || (
      meta ? { latitude: meta.latitude, longitude: meta.longitude } : null
    ),
    temperatureC: weather.temperatureC,
    precipitationProbability: weather.precipitationProbability == null
      ? null
      : Math.round(weather.precipitationProbability * 100),
    windSpeedKph: weather.windSpeedKph,
    windDirection: weather.windDirection,
    forecastTime: weather.forecastTime,
    outdoorExposure: weather.outdoorExposure,
    source: weather.source,
  };
}

function extractLineup(boxscore, side) {
  const team = boxscore?.teams?.[side];
  const batters = team?.batters || [];
  if (!batters.length) return null;
  const players = batters
    .map((id) => team.players?.[`ID${id}`]?.person?.fullName)
    .filter(Boolean);
  return players.length >= 9 ? players.slice(0, 9) : null;
}

function extractExternalLineup(externalEvidence, side) {
  const players = externalEvidence?.payload?.[side]?.players || [];
  const starters = players
    .filter((entry) => entry && entry.substitute !== true)
    .map((entry) => ({
      id: entry.player?.id ?? null,
      name: entry.player?.name ?? null,
      position: entry.position ?? entry.player?.position ?? null,
    }))
    .filter((player) => player.name);
  return starters.length >= 9 ? starters.slice(0, 9) : null;
}

async function collectBullpenUsage(teamId, commenceTime, activeRoster) {
  if (!teamId) return null;
  const games = await getMlbTeamSchedule(
    teamId,
    dateOffset(commenceTime, -16),
    dateOffset(commenceTime, -1)
  );
  const before = games
    .filter((game) => Date.parse(game.gameDate || '') < Date.parse(commenceTime))
    .filter((game) => game.status?.abstractGameState === 'Final')
    .sort((a, b) => Date.parse(b.gameDate) - Date.parse(a.gameDate))
    .slice(0, 7);
  if (!before.length) return null;

  const boxscores = await Promise.all(before.map((game) => getMlbGameBoxscore(game.gamePk)));
  const activePitcherIds = new Set(
    (activeRoster?.roster || [])
      .filter((player) => player.position === 'P')
      .map((player) => player.id)
      .filter(Boolean)
  );
  let pitcherAppearances = 0;
  let pitchesThrown = 0;
  let appearancesLast3 = 0;
  let pitchesLast3 = 0;
  const recentUsage = new Map();
  for (const [index, boxscore] of boxscores.entries()) {
    const side = boxscore?.teams?.home?.team?.id === teamId ? 'home' : 'away';
    const team = boxscore?.teams?.[side];
    const probableStarterId = team?.pitchers?.[0];
    for (const pitcherId of team?.pitchers || []) {
      if (pitcherId === probableStarterId) continue;
      const stat = team.players?.[`ID${pitcherId}`]?.stats?.pitching;
      if (!stat) continue;
      const pitches = Number(stat.pitchesThrown || 0);
      pitcherAppearances += 1;
      pitchesThrown += pitches;
      if (index < 3) {
        appearancesLast3 += 1;
        pitchesLast3 += pitches;
      }
      const player = recentUsage.get(pitcherId) || {
        id: pitcherId,
        name: team.players?.[`ID${pitcherId}`]?.person?.fullName ?? String(pitcherId),
        appearances: 0,
        pitches: 0,
        appearancesLast3: 0,
        pitchesLast3: 0,
      };
      player.appearances += 1;
      player.pitches += pitches;
      if (index < 3) {
        player.appearancesLast3 += 1;
        player.pitchesLast3 += pitches;
      }
      recentUsage.set(pitcherId, player);
    }
  }
  return {
    gamesObserved: boxscores.filter(Boolean).length,
    activePitchers: activePitcherIds.size || null,
    relieverAppearances: pitcherAppearances,
    relieverPitches: pitchesThrown,
    appearancesLast3,
    pitchesLast3,
    mostUsed: [...recentUsage.values()]
      .sort((a, b) => b.pitchesLast3 - a.pitchesLast3 || b.pitches - a.pitches)
      .slice(0, 5),
    note: '統計球隊最近官方完賽的全部後援負荷；active roster 僅供覆蓋參考，實際當晚可登板仍需球隊確認。',
  };
}

function distanceKm(a, b) {
  if (!a || !b) return null;
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(earthRadiusKm * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa)));
}

async function collectRest(teamId, commenceTime, targetVenue) {
  if (!teamId) return null;
  const games = await getMlbTeamSchedule(
    teamId,
    dateOffset(commenceTime, -10),
    dateOffset(commenceTime, -1)
  );
  const previous = games
    .filter((game) => Date.parse(game.gameDate || '') < Date.parse(commenceTime))
    .sort((a, b) => Date.parse(b.gameDate) - Date.parse(a.gameDate))[0];
  if (!previous) return null;
  const hours = (Date.parse(commenceTime) - Date.parse(previous.gameDate)) / 3600000;
  const previousVenue = await getMlbVenue(previous.venue?.id);
  return {
    previousGameTime: previous.gameDate,
    hoursSincePreviousGame: Math.round(hours * 10) / 10,
    restDays: Math.max(0, Math.floor(hours / 24) - 1),
    previousGamePk: previous.gamePk,
    previousVenue: previous.venue?.name ?? null,
    travelDistanceKm: distanceKm(coordinateFromVenue(previousVenue), coordinateFromVenue(targetVenue)),
  };
}

async function collectEvidence(game) {
  const capturedAt = nowIso();
  let schedule = [];
  let scheduleError = null;
  try {
    schedule = await getMlbScheduleAround(game.commence_time);
  } catch (err) {
    scheduleError = err.message;
  }

  const official = matchMlbOfficialGame(game, schedule);
  const pitOdds = resolvePitOdds(game.id, game.commence_time);
  const books = pitOdds.ok ? pitOdds.bookmakers : [];
  const market = bestFairH2h(books, game.home_team, game.away_team);
  const totalsMarket = bestFairTotals(books);
  const pitchers = getProbablePitchers(official);
  const starterCapturedAt = nowIso();
  const starterSnapshotWrite = recordMlbProbableStarterSnapshot({
    gameId: game.id,
    officialGamePk: official?.gamePk ?? null,
    commenceTime: game.commence_time,
    capturedAt: starterCapturedAt,
    pitchers,
  });
  const starterIdentitySnapshot = resolveMlbProbableStarterSnapshot(
    game.id,
    game.commence_time
  );
  const venueName = getVenueName(official);
  const homeTeamId = official?.teams?.home?.team?.id ?? null;
  const awayTeamId = official?.teams?.away?.team?.id ?? null;
  const venueId = official?.venue?.id ?? null;
  const externalLineupEvidence = getExternalLineupEvidence(game.id);
  const modelTeamHistory = buildMlbTeamFeatureStateAt(
    game.home_team,
    game.away_team,
    game.commence_time
  );
  const pitOptions = {
    cutoffDate: official?.officialDate ?? null,
    excludeGamePk: official?.gamePk ?? null,
  };
  const [
    venue,
    boxscore,
    homeActiveRoster,
    awayActiveRoster,
    homeInjuries,
    awayInjuries,
    homeOfficialHistory,
    awayOfficialHistory,
    homePitcherHistory,
    awayPitcherHistory,
    homePitcherRecent,
    awayPitcherRecent,
  ] =
    await Promise.all([
      getMlbVenue(venueId),
      getMlbGameBoxscore(official?.gamePk),
      getTeamActiveRoster(homeTeamId),
      getTeamActiveRoster(awayTeamId),
      getTeamInjuryList(homeTeamId),
      getTeamInjuryList(awayTeamId),
      getMlbOfficialPregameTeamFeatures(homeTeamId, game.commence_time, 30, pitOptions),
      getMlbOfficialPregameTeamFeatures(awayTeamId, game.commence_time, 30, pitOptions),
      getMlbPitcherPregameFeaturesFromGameLog(pitchers.home?.id, game.commence_time, pitOptions),
      getMlbPitcherPregameFeaturesFromGameLog(pitchers.away?.id, game.commence_time, pitOptions),
      getMlbPitcherRecentStartFeatures(pitchers.home?.id, game.commence_time, pitOptions),
      getMlbPitcherRecentStartFeatures(pitchers.away?.id, game.commence_time, pitOptions),
    ]);
  const platoonBlock = await buildMlbPregamePlatoonBlock({
    homePitcherId: pitchers.home?.id,
    awayPitcherId: pitchers.away?.id,
    homeTeamId,
    awayTeamId,
    commenceTime: game.commence_time,
  });
  const [weather, officialHomeLineup, officialAwayLineup, homeBullpen, awayBullpen, homeRest, awayRest] = await Promise.all([
    collectWeather(venue, game.commence_time, {
      gameId: game.id,
      venueName,
      homeTeam: game.home_team,
    }),
    Promise.resolve(extractLineup(boxscore, 'home')),
    Promise.resolve(extractLineup(boxscore, 'away')),
    collectBullpenUsage(homeTeamId, game.commence_time, homeActiveRoster),
    collectBullpenUsage(awayTeamId, game.commence_time, awayActiveRoster),
    collectRest(homeTeamId, game.commence_time, venue),
    collectRest(awayTeamId, game.commence_time, venue),
  ]);
  const externalHomeLineup = extractExternalLineup(externalLineupEvidence, 'home');
  const externalAwayLineup = extractExternalLineup(externalLineupEvidence, 'away');
  const homeLineup = officialHomeLineup || externalHomeLineup;
  const awayLineup = officialAwayLineup || externalAwayLineup;
  const lineupSource = officialHomeLineup && officialAwayLineup
    ? { name: 'MLB Stats API boxscore', ref: String(official?.gamePk || '') }
    : externalHomeLineup && externalAwayLineup
      ? {
          name: 'SofaScore collector audited prematch snapshot',
          ref: externalLineupEvidence.payloadSha256,
          capturedAt: externalLineupEvidence.capturedAt,
        }
      : null;
  const commenceMs = Date.parse(game.commence_time);
  const oddsExpiry = Number.isFinite(commenceMs)
    ? new Date(Math.min(commenceMs, Date.now() + 30 * 60 * 1000)).toISOString()
    : null;
  const starterInjuryConflicts = detectStarterInjuryConflicts(
    pitchers,
    homeInjuries,
    awayInjuries
  );
  const startersComplete = Boolean(pitchers.home && pitchers.away);
  const starterEvidenceStatus = starterInjuryConflicts.length
    ? 'conflicting'
    : startersComplete
      ? 'partial'
      : 'missing';

  const officialNoteFor = (pitcher, injuryPayload) => {
    if (!pitcher?.id) return [];
    const hit = (injuryPayload?.roster || []).find((entry) => entry.id === pitcher.id);
    if (!hit) return [];
    return [{
      title: `Official IL / injury roster: ${pitcher.name}`,
      url: `mlb-stats-api://il/${pitcher.id}`,
      snippet: `${pitcher.name} appears on official injury roster` +
        `${hit.status ? ` (${hit.status})` : ''}.`,
      source: 'mlb_stats_api_il',
    }];
  };

  let pitcherInjuryIntel = { home: null, away: null };
  if (config.enablePitcherInjuryIntel && (pitchers.home?.name || pitchers.away?.name)) {
    try {
      pitcherInjuryIntel = await analyzeGamePitcherInjuryIntel({
        gameId: game.id,
        commenceTime: game.commence_time,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        homePitcher: pitchers.home,
        awayPitcher: pitchers.away,
        league: 'MLB',
        homeOfficialNotes: officialNoteFor(pitchers.home, homeInjuries),
        awayOfficialNotes: officialNoteFor(pitchers.away, awayInjuries),
      });
    } catch (error) {
      pitcherInjuryIntel = {
        home: { ok: false, error: String(error?.message || error), result: null, materials: [] },
        away: { ok: false, error: String(error?.message || error), result: null, materials: [] },
      };
    }
  }
  const pitcherInjuryEvidence = summarizePitcherInjuryIntelEvidence(
    pitcherInjuryIntel.home,
    pitcherInjuryIntel.away
  );

  const items = [
    evidence(
      'fixture',
      official ? 'verified' : 'partial',
      official
        ? {
            summary: 'MLB 官方賽程已匹配',
            source: 'MLB Stats API schedule',
            sourceRef: String(official.gamePk || ''),
            values: { gamePk: official.gamePk, gameDate: official.gameDate },
            capturedAt: starterCapturedAt,
          }
        : {
            summary: '僅有賠率來源場次資訊，未匹配官方賽程',
            source: 'The Odds API',
            values: { gameId: game.id },
            capturedAt: starterCapturedAt,
            reason: scheduleError || 'official_schedule_not_matched',
          }
    ),
    evidence(
      'odds',
      market ? 'verified' : 'missing',
      market
        ? {
            summary: `${market.bookmaker} 雙邊 h2h 去水盤`,
            source: 'The Odds API',
            sourceRef: `${pitOdds.snapshotId}:${market.bookmaker}`,
            values: {
              ...market,
              snapshotId: pitOdds.snapshotId,
              oddsSource: pitOdds.source,
              selectionPolicy: pitOdds.selectionPolicy,
            },
            capturedAt: pitOdds.capturedAt,
            validUntil: oddsExpiry,
            usedInModel: false,
          }
        : {
            summary: pitOdds.ok
              ? 'PIT 快照沒有同一 bookmaker 的完整 h2h 雙邊盤'
              : '找不到可驗證的開賽前賠率快照',
            source: 'The Odds API',
            capturedAt,
            reason: pitOdds.ok ? 'paired_h2h_market_missing' : pitOdds.reason,
          }
    ),
    evidence(
      'venue',
      venueName ? 'verified' : 'missing',
      venueName
        ? {
            summary: venueName,
            source: 'MLB Stats API schedule',
            sourceRef: String(official?.venue?.id || ''),
            values: { venueName, venueId: official?.venue?.id ?? null },
            capturedAt,
          }
        : {
            summary: '官方球場資料未取得',
            source: 'MLB Stats API schedule',
            capturedAt,
            reason: official ? 'venue_missing' : 'official_schedule_missing',
          }
    ),
    evidence(
      'starting_pitchers',
      starterEvidenceStatus,
      startersComplete
        ? {
            summary:
              `官方預定先發：主 ${pitchers.home.name}` +
              `（ERA ${formatRate(homePitcherHistory?.era)}／K/9 ${formatRate(homePitcherHistory?.strikeoutsPer9)}／休 ${homePitcherRecent?.restDays ?? '?'} 日）` +
              `；客 ${pitchers.away.name}` +
              `（ERA ${formatRate(awayPitcherHistory?.era)}／K/9 ${formatRate(awayPitcherHistory?.strikeoutsPer9)}／休 ${awayPitcherRecent?.restDays ?? '?'} 日）` +
              (starterInjuryConflicts.length
                ? `；來源衝突：${starterInjuryConflicts.map((entry) => entry.pitcher.name).join('、')} 同時列於官方 IL`
                : ''),
            source: 'MLB Stats API schedule + people/stats byDateRange',
            values: {
              confirmationLevel: 'probable',
              identitySnapshot: starterIdentitySnapshot.ok
                ? {
                    snapshotId: starterIdentitySnapshot.snapshotId,
                    capturedAt: starterIdentitySnapshot.capturedAt,
                    source: starterIdentitySnapshot.source,
                    status: starterIdentitySnapshot.status,
                    preferredCompleteOverLaterPartial: Boolean(
                      starterIdentitySnapshot.preferredCompleteOverLaterPartial
                    ),
                    laterPartialCapturedAt:
                      starterIdentitySnapshot.laterPartialCapturedAt || null,
                  }
                : null,
              conflicts: starterInjuryConflicts,
              home: {
                ...pitchers.home,
                pregameStats: homePitcherHistory,
                recentStartStats: homePitcherRecent,
              },
              away: {
                ...pitchers.away,
                pregameStats: awayPitcherHistory,
                recentStartStats: awayPitcherRecent,
              },
            },
            capturedAt: starterCapturedAt,
            reason: starterInjuryConflicts.length
              ? 'probable_pitcher_conflicts_with_injury_list'
              : 'official_probable_pitchers_are_not_confirmed_lineup_cards',
          }
        : {
            summary: '尚無雙方官方預定先發',
            source: 'MLB Stats API schedule',
            capturedAt: starterCapturedAt,
            reason: 'both_probable_pitchers_required',
          }
    ),
    evidence(
      'official_history',
      homeOfficialHistory && awayOfficialHistory ? 'verified' : 'missing',
      homeOfficialHistory && awayOfficialHistory
        ? {
            summary:
              `官方截至 ${homeOfficialHistory.asOfDate}：主 ${recordLabel(homeOfficialHistory.record)}；` +
              `客 ${recordLabel(awayOfficialHistory.record)}。近30日 OPS ` +
              `${formatRate(homeOfficialHistory.offense.ops, 3)}/${formatRate(awayOfficialHistory.offense.ops, 3)}；` +
              `投手 BB/9 ${formatRate(homeOfficialHistory.pitching.walksPer9)}/${formatRate(awayOfficialHistory.pitching.walksPer9)}；` +
              `K/9 ${formatRate(homeOfficialHistory.pitching.strikeoutsPer9)}/${formatRate(awayOfficialHistory.pitching.strikeoutsPer9)}`,
            source: 'MLB Stats API teams/stats + schedule',
            values: { home: homeOfficialHistory, away: awayOfficialHistory },
            capturedAt,
            usedInModel: false,
          }
        : {
            summary: '無法取得雙方截至比賽日前的官方歷史球隊特徵',
            source: 'MLB Stats API teams/stats + schedule',
            capturedAt,
            reason: 'official_historical_features_missing',
          }
    ),
    evidence(
      'bullpen',
      homeBullpen && awayBullpen ? 'partial' : 'missing',
      homeBullpen && awayBullpen
        ? {
            summary: `近 3 場後援負荷：主 ${homeBullpen.pitchesLast3} 球／${homeBullpen.appearancesLast3} 人次；客 ${awayBullpen.pitchesLast3} 球／${awayBullpen.appearancesLast3} 人次`,
            source: 'MLB Stats API schedule + boxscore',
            values: {
              home: homeBullpen,
              away: awayBullpen,
              homeActiveRoster: homeActiveRoster.ok,
              awayActiveRoster: awayActiveRoster.ok,
            },
            capturedAt,
            reason: 'bullpen_availability_not_confirmed',
          }
        : {
            summary: '無法完整取得兩隊近 3 場後援使用量',
            reason: 'bullpen_usage_data_missing',
            capturedAt,
          }
    ),
    evidence(
      'lineup',
      homeLineup && awayLineup ? 'verified' : 'missing',
      homeLineup && awayLineup
        ? {
            summary: `確認打線已取得：主／客各 ${homeLineup.length}/${awayLineup.length} 人`,
            source: lineupSource?.name || 'unknown',
            sourceRef: lineupSource?.ref || null,
            values: { home: homeLineup, away: awayLineup },
            capturedAt: lineupSource?.capturedAt || capturedAt,
          }
        : {
            summary: '官方確認先發打線尚未公布',
            source: 'MLB Stats API boxscore',
            capturedAt,
            reason: 'confirmed_lineup_missing',
          }
    ),
    evidence(
      'injuries',
      homeInjuries.ok && awayInjuries.ok ? 'verified' : 'missing',
      homeInjuries.ok && awayInjuries.ok
        ? {
            summary:
              `官方 IL：主 ${injuryRosterSummary(homeInjuries.roster)}；` +
              `客 ${injuryRosterSummary(awayInjuries.roster)}`,
            source: 'MLB Stats API 40-man roster injured status',
            values: { home: homeInjuries.roster, away: awayInjuries.roster },
            capturedAt,
            usedInModel: false,
          }
        : {
            summary: '無法取得完整官方傷兵名單',
            source: 'MLB Stats API 40-man roster injured status',
            capturedAt,
            reason: homeInjuries.error || awayInjuries.error || 'injury_list_missing',
          }
    ),
    evidence(
      'pitcher_injury_intel',
      pitcherInjuryEvidence.status,
      {
        summary: pitcherInjuryEvidence.summary,
        source: 'Google News RSS + DeepSeek structured flags',
        values: pitcherInjuryEvidence.values,
        capturedAt,
        usedInModel: false,
        reason: pitcherInjuryEvidence.reason,
      }
    ),
    evidence(
      'park',
      venueName || game.home_team ? 'verified' : 'missing',
      venueName || game.home_team
        ? {
            summary:
              `球場 ${venueName || resolveMlbVenueMeta({ homeTeam: game.home_team })?.venueName || '主場'}；` +
              `靜態跑分係數 ×${resolveMlbParkFactor({
                venueName,
                homeTeam: game.home_team,
              }).toFixed(2)}`,
            source: 'static parkFactors + MLB venue / home-team map',
            sourceRef: String(venueId || ''),
            values: {
              venueName: venueName || resolveMlbVenueMeta({ homeTeam: game.home_team })?.venueName || null,
              parkFactor: resolveMlbParkFactor({
                venueName,
                homeTeam: game.home_team,
              }),
              roofType: venue?.fieldInfo?.roofType ??
                resolveMlbVenueMeta({ venueName, homeTeam: game.home_team })?.roof ??
                null,
              turfType: venue?.fieldInfo?.turfType ?? null,
            },
            capturedAt,
            usedInModel: true,
          }
        : {
            summary: '球場未確認，無法套用球場環境',
            capturedAt,
            reason: 'venue_missing',
          }
    ),
    evidence(
      'weather',
      weather ? 'verified' : 'missing',
      weather
        ? {
            summary: `${weather.temperatureC ?? '?'}°C · 風 ${weather.windSpeedKph ?? '?'} km/h · 降雨 ${weather.precipitationProbability ?? '?'}%`,
            source: weather.source || 'Open-Meteo hourly',
            values: weather,
            capturedAt,
            validUntil: oddsExpiry,
            usedInModel: true,
          }
        : {
            summary: '無法取得比賽時段逐小時天氣預報',
            reason: 'weather_forecast_missing',
            capturedAt,
          }
    ),
    evidence(
      'travel_rest',
      homeRest && awayRest ? 'partial' : 'missing',
      homeRest && awayRest
        ? {
            summary: `距前一戰：主 ${homeRest.hoursSincePreviousGame} 小時／${homeRest.travelDistanceKm ?? '?'} km；客 ${awayRest.hoursSincePreviousGame} 小時／${awayRest.travelDistanceKm ?? '?'} km`,
            source: 'MLB Stats API team schedule',
            values: { home: homeRest, away: awayRest },
            capturedAt,
            reason: 'previous_game_end_time_not_available',
          }
        : {
            summary: '無法完整推導兩隊前一戰與休息時間',
            reason: 'team_schedule_history_missing',
            capturedAt,
          }
    ),
  ];

  const modelHistoryReady =
    modelTeamHistory.home.wins + modelTeamHistory.home.losses >= 5 &&
    modelTeamHistory.away.wins + modelTeamHistory.away.losses >= 5;
  items.push(evidence('model_history', modelHistoryReady ? 'verified' : 'partial', {
    summary:
      `模型同口徑 PIT：主 ${modelTeamHistory.home.wins}-${modelTeamHistory.home.losses}；` +
      `客 ${modelTeamHistory.away.wins}-${modelTeamHistory.away.losses}`,
    source: modelTeamHistory.source,
    values: modelTeamHistory,
    capturedAt,
    usedInModel: true,
    reason: modelHistoryReady ? null : 'model_history_sample_insufficient',
  }));

  const expectedRunsModel = getLatestMlbExpectedRunsValidation();
  const formalModelVersion = resolveFormalModelVersion(expectedRunsModel);
  const expectedRunsFeatureKeys = expectedRunsModel?.model?.featureKeys || [];
  const usesStarterFeatures = expectedRunsFeatureKeys.some(
    (key) =>
      String(key).startsWith('starter') ||
      String(key).includes('opponentStarter') ||
      String(key).includes('offenseOpsVsStarter')
  );
  const usesBullpenFeatures = expectedRunsFeatureKeys.some((key) =>
    String(key).toLowerCase().includes('bullpen')
  );

  // critical 證據未就緒不得推薦／紙上晉升
  // 先發：雙方 official probable（status=partial）即可，不必等確認打線
  const mandatory = getMandatoryEvidenceKeys();
  const mandatoryFailures = mandatory.flatMap((key) => {
    const item = items.find((row) => row.key === key);
    if (!item) return [`${key}:missing`];
    if (!isEvidenceReadyForRecommend(item, key)) return [`${key}:${item.status}`];
    return [];
  });
  const pitcherEvidence = items.find((item) => item.key === 'starting_pitchers');
  if (pitcherEvidence) pitcherEvidence.usedInModel = usesStarterFeatures;
  const bullpenEvidence = items.find((item) => item.key === 'bullpen');
  if (bullpenEvidence) bullpenEvidence.usedInModel = usesBullpenFeatures;
  const featureVector = composeMlbFeatureVector(
    modelTeamHistory.vector,
    homePitcherHistory,
    awayPitcherHistory,
    homePitcherRecent,
    awayPitcherRecent,
    homeBullpen,
    awayBullpen
  );

  let baselinePayload = null;
  let shadowModels = {};
  if (config.mlbBaselineShadowEnabled) {
    const baseline = getLatestMlbBaselineModel();
    const baselineFeaturesAvailable =
      baseline &&
      featureVector &&
      baseline.model.featureKeys.every((key) => Number.isFinite(featureVector[key]));
    const baselineHomeProb = baselineFeaturesAvailable
      ? predictMlbBaseline(baseline.model, featureVector)
      : null;
    shadowModels = Object.fromEntries(
      Object.entries(baseline?.metrics?.researchChallengers || {}).map(([key, challenger]) => {
        const model = challenger?.model;
        const usesPitcher = model?.featureKeys?.some((feature) => feature.startsWith('pitcher'));
        const conflictBlocked = usesPitcher && starterInjuryConflicts.length > 0;
        const featuresAvailable = model?.featureKeys?.every((feature) =>
          Number.isFinite(featureVector?.[feature])
        );
        return [key, {
          status: conflictBlocked
            ? 'blocked_source_conflict'
            : featuresAvailable
              ? 'shadow_scored'
              : 'blocked_features_missing',
          role: 'shadow_only',
          homeProb: !conflictBlocked && featuresAvailable
            ? predictMlbBaseline(model, featureVector)
            : null,
          awayProb: !conflictBlocked && featuresAvailable
            ? 1 - predictMlbBaseline(model, featureVector)
            : null,
          deployable: false,
          blockReason: conflictBlocked
            ? 'probable_pitcher_conflicts_with_injury_list'
            : challenger.blockReason ?? null,
        }];
      })
    );
    if (baselineHomeProb != null) {
      baselinePayload = {
        role: 'shadow_only',
        featureVersion: baseline.featureVersion,
        trainedAt: baseline.createdAt,
        metrics: baseline.metrics,
        featureVector,
        homeProb: baselineHomeProb,
        awayProb: 1 - baselineHomeProb,
        shadowModels,
      };
    }
  }
  const expectedRunsRecentBoxscore = await buildMlbRecentBoxscoreFeaturesAt({
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time,
  });
  const strictStarterIdentity =
    starterIdentitySnapshot.ok &&
    starterIdentitySnapshot.status === 'complete' &&
    starterInjuryConflicts.length === 0;
  const expectedRunsFeatures = {
    home: modelTeamHistory.home,
    away: modelTeamHistory.away,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    venueName,
    gameId: game.id,
    commenceTime: game.commence_time,
    parkFactor: resolveMlbParkFactor({
      venueName,
      homeTeam: game.home_team,
    }),
    weather: weather
      ? {
          temperatureC: weather.temperatureC,
          windSpeedKph: weather.windSpeedKph,
          precipitationProbability:
            weather.precipitationProbability == null
              ? null
              : Number(weather.precipitationProbability) / 100,
          windDirection: weather.windDirection,
          outdoorExposure: weather.outdoorExposure,
          source: weather.source,
        }
      : null,
    pitchers: {
      source: strictStarterIdentity
        ? 'MLB Stats API schedule probable starter snapshot; strict pregame identity'
        : 'probable incomplete or conflict; expected-runs uses fallback feature set',
      identityMode: strictStarterIdentity ? 'pit_probable' : 'live_fallback',
      identitySnapshotId: starterIdentitySnapshot.ok
        ? starterIdentitySnapshot.snapshotId
        : null,
      homeIdentity: strictStarterIdentity
        ? starterIdentitySnapshot.home
        : pitchers.home
          ? { id: pitchers.home.id, name: pitchers.home.name }
          : null,
      awayIdentity: strictStarterIdentity
        ? starterIdentitySnapshot.away
        : pitchers.away
          ? { id: pitchers.away.id, name: pitchers.away.name }
          : null,
      home: homePitcherHistory,
      away: awayPitcherHistory,
      homeRecent: homePitcherRecent,
      awayRecent: awayPitcherRecent,
      homeHand: platoonBlock?.home?.pitchHand || null,
      awayHand: platoonBlock?.away?.pitchHand || null,
    },
    platoon: platoonBlock,
    recentBoxscore: expectedRunsRecentBoxscore,
  };
  const selectedExpectedRunsModel = strictStarterIdentity
    ? expectedRunsModel?.model
    : expectedRunsModel?.model?.fallbackModel;
  const marketOptionsForOverlay = {
    totalLine: Number(totalsMarket?.line ?? market?.totalsLine ?? market?.totalLine ?? 8.5),
  };
  const expectedRunsPredictionRaw = selectedExpectedRunsModel
    ? predictMlbGameRuns(
        selectedExpectedRunsModel,
        expectedRunsFeatures,
        marketOptionsForOverlay
      )
    : null;
  const expectedRunsPrediction = expectedRunsPredictionRaw
    ? applyFormalLockedBResidual(
        selectedExpectedRunsModel,
        expectedRunsPredictionRaw,
        expectedRunsFeatures,
        marketOptionsForOverlay
      )
    : null;
  const expectedRunsPredictionRouted = expectedRunsPrediction
    ? attachMlbRegimeMarketPlan(expectedRunsPrediction, expectedRunsFeatures, marketOptionsForOverlay)
    : null;
  const marketPlan = expectedRunsPredictionRouted?.marketPlan || null;
  const regimeSignals = expectedRunsPredictionRouted?.marketPlan
    ? buildPregameRegimeSignals(expectedRunsFeatures)
    : null;
  const totalsSatellite = expectedRunsPredictionRouted
    ? applyTotalsFragileUnderShadow(
        classifyMlbTotalsSatelliteCandidate({
          prediction: expectedRunsPredictionRouted,
          totalsMarket,
        }),
        expectedRunsFeatures
      )
    : {
        tier: 'blocked',
        market: 'totals',
        side: null,
        reasons: ['totals_prediction_missing'],
        researchOnly: true,
        specId: MLB_TOTALS_SATELLITE_SPEC.id,
      };
  const totalsSatelliteHybrid = expectedRunsPredictionRouted
    ? applyTotalsUnderPitcherToCandidate(
        applyTotalsFragileUnderShadow(
          classifyMlbTotalsHybridCandidate({
            prediction: expectedRunsPredictionRouted,
            totalsMarket,
            parkFactor: expectedRunsFeatures.parkFactor,
            spec: {
              ...MLB_TOTALS_SATELLITE_HYBRID_SPEC,
              rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
            },
          }),
          expectedRunsFeatures
        )
      )
    : {
        tier: 'blocked',
        market: 'totals',
        side: null,
        reasons: ['totals_prediction_missing'],
        researchOnly: false,
        specId: MLB_TOTALS_SATELLITE_HYBRID_SPEC.id,
      };
  let moneylineClassification = expectedRunsPredictionRouted
    ? classifyMlbMoneylineCandidate({
      prediction: expectedRunsPredictionRouted,
      market,
      modelStatus: strictStarterIdentity
        ? 'research_scored'
        : 'research_scored_fallback',
      regimeSignals,
      features: expectedRunsFeatures,
      pitcherIdentity: {
        homeId:
          expectedRunsFeatures.pitchers.homeIdentity?.id ??
          pitchers.home?.id ??
          null,
        awayId:
          expectedRunsFeatures.pitchers.awayIdentity?.id ??
          pitchers.away?.id ??
          null,
      },
    })
    : null;
  if (
    moneylineClassification &&
    marketPlan &&
    marketPlan.moneylinePriority === 'blocked'
  ) {
    moneylineClassification = {
      ...moneylineClassification,
      tier: 'blocked',
      reasons: [
        ...(moneylineClassification.reasons || []),
        'regime_routes_to_totals',
        marketPlan.reason,
      ],
    };
  } else if (
    moneylineClassification &&
    marketPlan &&
    marketPlan.moneylinePriority === 'secondary'
  ) {
    moneylineClassification = {
      ...moneylineClassification,
      reasons: [
        ...(moneylineClassification.reasons || []),
        'regime_totals_primary_moneyline_secondary',
        marketPlan.reason,
      ],
    };
  }
  let highWeightFeatureSync = null;
  if (
    starterIdentitySnapshot.ok &&
    starterIdentitySnapshot.status === 'complete' &&
    Number(game.completed) === 1
  ) {
    try {
      highWeightFeatureSync = await syncPitProbableIntoFeatureRows({
        gameIds: [game.id],
        concurrency: 1,
      });
    } catch (error) {
      highWeightFeatureSync = {
        ok: false,
        error: String(error?.message || error),
      };
    }
  }
  const expectedRuns = selectedExpectedRunsModel
    ? {
        status: strictStarterIdentity
          ? 'research_scored'
          : starterInjuryConflicts.length
            ? 'research_scored_fallback_source_conflict'
            : 'research_scored_fallback_no_starter',
        modelVersion: expectedRunsModel.modelVersion,
        trainedAt: expectedRunsModel.createdAt,
        starterIdentity: starterIdentitySnapshot,
        featureMode: strictStarterIdentity
          ? 'full_with_pit_probable'
          : 'fallback_without_starter',
        prediction: expectedRunsPredictionRouted,
        marketPlan,
        totalsDecision: expectedRunsPredictionRouted?.totalsDecision || null,
        totalsSatellite,
        totalsSatelliteHybrid,
        totalsMarket: totalsMarket
          ? {
              line: totalsMarket.line,
              overOdds: totalsMarket.overOdds,
              underOdds: totalsMarket.underOdds,
              bookmaker: totalsMarket.bookmaker,
              totalsBookCount: totalsMarket.totalsBookCount,
            }
          : null,
        moneylineClassification,
        highWeightFeatureSync,
        starterSnapshotWrite,
      }
    : {
        status: 'blocked_model_missing',
        modelVersion: expectedRunsModel?.modelVersion ?? null,
        trainedAt: expectedRunsModel?.createdAt ?? null,
        starterIdentity: starterIdentitySnapshot,
        featureMode: null,
        prediction: null,
        marketPlan: null,
        totalsDecision: null,
        totalsSatellite: {
          tier: 'blocked',
          market: 'totals',
          side: null,
          reasons: ['expected_runs_model_or_features_missing'],
          researchOnly: true,
          specId: MLB_TOTALS_SATELLITE_SPEC.id,
        },
        totalsSatelliteHybrid: {
          tier: 'blocked',
          market: 'totals',
          side: null,
          reasons: ['expected_runs_model_or_features_missing'],
          researchOnly: false,
          specId: MLB_TOTALS_SATELLITE_HYBRID_SPEC.id,
        },
        totalsMarket: totalsMarket
          ? {
              line: totalsMarket.line,
              overOdds: totalsMarket.overOdds,
              underOdds: totalsMarket.underOdds,
              bookmaker: totalsMarket.bookmaker,
              totalsBookCount: totalsMarket.totalsBookCount,
            }
          : null,
        moneylineClassification: null,
        highWeightFeatureSync,
        starterSnapshotWrite,
      };

  return {
    items,
    market,
    formalModelVersion,
    baseline: baselinePayload,
    expectedRuns,
    completeness: calculateCompleteness(items),
    mandatoryComplete: mandatoryFailures.length === 0,
    gateReasons: mandatoryFailures,
  };
}

function insertTruthSnapshot(runId, game, truth) {
  return db.prepare(`
    INSERT INTO mlb_prematch_truth_snapshots
      (run_id, game_id, commence_time, home_team, away_team, evidence_json,
       completeness, mandatory_complete, gate_status, gate_reasons_json,
       source_versions_json, model_input_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    game.id,
    game.commence_time,
    game.home_team,
    game.away_team,
    JSON.stringify(truth.items),
    truth.completeness,
    truth.mandatoryComplete ? 1 : 0,
    truth.mandatoryComplete ? 'research_ready' : 'blocked_data',
    JSON.stringify(truth.gateReasons),
    JSON.stringify({
      evidence: EVIDENCE_VERSION,
      model: truth.formalModelVersion || resolveFormalModelVersion(),
      strategy: STRATEGY_VERSION,
      inferenceSkeleton: MLB_INFERENCE_FREEZE.skeleton,
      baselineShadowEnabled: config.mlbBaselineShadowEnabled,
      baseline: truth.baseline
        ? {
            role: 'shadow_only',
            featureVersion: truth.baseline.featureVersion,
            trainedAt: truth.baseline.trainedAt,
          selectedVariant: truth.baseline.metrics?.selectedVariant ?? null,
          testMetrics: truth.baseline.metrics?.[
            {
              team_only: 'teamOnly',
              team_plus_bullpen: 'teamPlusBullpen',
              team_plus_season_pitcher: 'teamPlusSeasonPitcher',
              team_plus_recent_pitcher: 'teamPlusRecentPitcher',
            }[truth.baseline.metrics?.selectedVariant] || 'teamOnly'
          ]?.test ?? null,
          }
        : null,
      expectedRuns: {
        modelVersion: truth.expectedRuns?.modelVersion ?? null,
        trainedAt: truth.expectedRuns?.trainedAt ?? null,
        status: truth.expectedRuns?.status ?? 'blocked_model_missing',
      },
    }),
    // 正式路徑必須持久化 expectedRuns（含 moneylineClassification），
    // 不可依賴 baseline shadow；否則讀取 slate 時無法排 Top／出選邊。
    JSON.stringify({
      featureVersion: truth.baseline?.featureVersion ?? null,
      trainedAt: truth.baseline?.trainedAt ?? null,
      featureVector: truth.baseline?.featureVector ?? null,
      homeProb: truth.baseline?.homeProb ?? null,
      awayProb: truth.baseline?.awayProb ?? null,
      shadowModels: truth.baseline?.shadowModels ?? null,
      expectedRuns: truth.expectedRuns,
    })
  ).lastInsertRowid;
}

/**
 * @deprecated Baseline edge 不定邊；保留僅供 shadow／舊腳本對照。
 * 正式研究方向請用 selectExpectedRunsResearchDirection。
 */
export function selectBaselineH2hEdge(model, market) {
  if (!model || !market) return null;
  const selection = selectResearchDirection({
    homeTeam: '__home__',
    awayTeam: '__away__',
    homeModelProb: Number(model.homeProb),
    awayModelProb: Number(model.awayProb),
    market,
  });
  if (!selection) return null;
  return {
    ...selection,
    pickHome: selection.side === 'home',
  };
}

function insertResearchCandidate(truthSnapshotId, game, truth) {
  const market = truth.market;
  const expectedRuns = truth.expectedRuns;
  const classification = expectedRuns?.moneylineClassification || null;
  const selection = classification && market
    ? selectExpectedRunsResearchDirection({
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        classification,
        market,
      })
    : null;
  const pick = selection?.pick ?? null;
  const odds = selection?.oddsDecimal ?? null;
  const marketProb = selection?.marketProb ?? null;
  const modelProb = selection?.modelProb ?? null;
  const tier = classification?.tier || null;
  const rejectionReasons = [
    ...truth.gateReasons,
    ...(expectedRuns?.prediction ? [] : ['expected_runs_model_or_features_missing']),
    ...((classification?.reasons || []).filter((reason) =>
      reason !== 'strict_pit_starter_required' || tier !== 'recommendation'
    )),
  ];
  const status = !truth.mandatoryComplete
    ? 'blocked_data'
    : !expectedRuns?.prediction
      ? 'blocked_model'
      : tier === 'recommendation'
        ? 'research_observation'
        : tier === 'value_watch'
          ? 'value_watch'
          : 'no_signal';
  return db.prepare(`
    INSERT INTO mlb_paper_candidates
      (truth_snapshot_id, game_id, market, pick, odds_decimal, market_prob, model_prob,
       model_version, strategy_version, status, rejection_reasons_json)
    VALUES (?, ?, 'h2h', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    truthSnapshotId,
    game.id,
    pick,
    odds,
    marketProb,
    modelProb,
    expectedRuns?.modelVersion || resolveFormalModelVersion(),
    STRATEGY_VERSION,
    status,
    JSON.stringify(rejectionReasons)
  ).lastInsertRowid;
}

export async function runMlbPrematchTruthPipeline() {
  const runId = `truth-${randomUUID()}`;
  const games = db.prepare(`
    SELECT *
    FROM games
    WHERE league = 'MLB'
      AND completed = 0
      AND datetime(commence_time) > datetime('now')
      AND datetime(commence_time) <= datetime('now', '+${config.upcomingGameHorizonHours} hours')
    ORDER BY datetime(commence_time) ASC
  `).all();

  let collected = 0;
  let failures = 0;
  const transaction = db.transaction((entries) => {
    for (const { game, truth } of entries) {
      const snapshotId = insertTruthSnapshot(runId, game, truth);
      insertResearchCandidate(snapshotId, game, truth);
    }
  });

  const entries = [];
  for (const game of games) {
    try {
      entries.push({ game, truth: await collectEvidence(game) });
      collected += 1;
    } catch (err) {
      failures += 1;
      console.warn(`[mlb-truth] ${game.id} 蒐集失敗:`, err.message);
    }
  }
  transaction(entries);

  return {
    runId,
    games: games.length,
    collected,
    failures,
    modelVersion: resolveFormalModelVersion(),
    strategyVersion: STRATEGY_VERSION,
    inferenceSkeleton: MLB_INFERENCE_FREEZE.skeleton,
    baselineShadowEnabled: config.mlbBaselineShadowEnabled,
    mode: 'research_only',
  };
}

function latestTruthRows({ from, to } = {}) {
  const params = [];
  let dateClause = '';
  if (from) {
    dateClause += ' AND datetime(t.commence_time) >= datetime(?)';
    params.push(from);
  }
  if (to) {
    dateClause += ' AND datetime(t.commence_time) <= datetime(?)';
    params.push(to);
  }
  return db.prepare(`
    WITH ranked AS (
      SELECT t.*,
             ROW_NUMBER() OVER (PARTITION BY t.game_id ORDER BY datetime(t.captured_at) DESC, t.id DESC) AS rn
      FROM mlb_prematch_truth_snapshots t
      WHERE 1 = 1 ${dateClause}
    )
    SELECT t.*, c.id AS candidate_id, c.market, c.pick, c.odds_decimal, c.market_prob,
           c.model_prob, c.status AS candidate_status, c.rejection_reasons_json,
           g.completed, g.status AS game_status
    FROM ranked t
    JOIN games g ON g.id = t.game_id
    LEFT JOIN mlb_paper_candidates c ON c.truth_snapshot_id = t.id
    WHERE t.rn = 1
    ORDER BY datetime(t.commence_time) ASC
  `).all(...params);
}

/**
 * 放出窗內 TopK 場次：晉升 paper_candidate 並立即建紙上注（凍結選邊）。
 * 不呼叫 promoteDailyLockedBPaperCandidates（其內部會再 getSlate，避免遞迴）。
 */
function ensureLockedBPaperFillsForReleasedTop(readyTopGames, nowMs) {
  const update = db.prepare(`
    UPDATE mlb_paper_candidates
    SET status = 'paper_candidate',
        rejection_reasons_json = ?
    WHERE id = ?
      AND status IN ('research_observation', 'value_watch', 'no_signal')
  `);
  let filled = 0;
  for (const game of readyTopGames) {
    if (!game?.candidateId) continue;
    if (!game.dataReadiness?.recommendationAllowed) continue;
    if (!game.research?.pick || !Number.isFinite(Number(game.research?.oddsDecimal))) continue;
    if (!isWithinLockedBReleaseWindow(game.commenceTime, nowMs)) continue;
    const commenceMs = Date.parse(game.commenceTime);
    if (Number.isFinite(commenceMs) && commenceMs <= nowMs) continue;

    if (!hasMlbPaperMoneylineBet(game.gameId)) {
      const reasons = [
        ...(Array.isArray(game.research?.rejectionReasons)
          ? game.research.rejectionReasons
          : []),
        'path_gamma_locked_b_daily_slot',
        `daily_rank_${game.dailyRank}`,
        'slate_ensure_fill_on_release',
        ...(Number(config.mlbLockedBReleaseHoursBefore) > 0
          ? [`release_within_${config.mlbLockedBReleaseHoursBefore}h`]
          : []),
      ];
      update.run(JSON.stringify(reasons), game.candidateId);
      const created = createPaperBetFromCandidate(game.candidateId);
      if (created.created || created.reason === 'game_market_already_recorded') {
        filled += 1;
      }
    }
    suppressMlbTotalsHybridFreezeForMoneyline(game.gameId);
  }
  return { filled };
}

function summarizePaperFrozenPick(bet, index) {
  const release = lockedBReleaseWindowMeta(bet.commence_time);
  return {
    researchDay: new Date(bet.commence_time).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Hong_Kong',
    }),
    dailyRank: index + 1,
    researchTier: 'paper_frozen',
    rank: index + 1,
    gameId: bet.game_id,
    matchup: `${bet.away_team} @ ${bet.home_team}`,
    commenceTime: bet.commence_time,
    pick: bet.pick,
    edge:
      Number.isFinite(Number(bet.model_prob)) && Number.isFinite(Number(bet.market_prob))
        ? Number(bet.model_prob) - Number(bet.market_prob)
        : null,
    ev:
      Number.isFinite(Number(bet.model_prob)) && Number.isFinite(Number(bet.odds_decimal))
        ? Number(bet.model_prob) * Number(bet.odds_decimal) - 1
        : null,
    modelProb: bet.model_prob,
    marketProb: bet.market_prob,
    modelProbability: bet.model_prob,
    marketProbability: bet.market_prob,
    expectedRunMargin: null,
    expectedValue:
      Number.isFinite(Number(bet.model_prob)) && Number.isFinite(Number(bet.odds_decimal))
        ? Number(bet.model_prob) * Number(bet.odds_decimal) - 1
        : null,
    oddsDecimal: bet.odds_decimal,
    status: 'paper_frozen',
    recommendationAllowed: true,
    dataScorePct: null,
    missingCritical: [],
    dataReadiness: null,
    frozen: true,
    frozenAt: bet.created_at,
    paperBetId: bet.id,
    releaseWindow: release,
  };
}

export function getMlbPrematchTruthSlate({ from, to } = {}) {
  const rows = latestTruthRows({ from, to });
  const mapped = rows.map((row) => {
    const modelInput = JSON.parse(row.model_input_json || '{}');
    const evidence = JSON.parse(row.evidence_json || '[]');
    const dataReadiness = buildDataReadiness(evidence);
    const modelProb = Number(row.model_prob);
    const marketProb = Number(row.market_prob);
    const edge = Number.isFinite(modelProb) && Number.isFinite(marketProb)
      ? modelProb - marketProb
      : null;
    const ev = Number.isFinite(modelProb) && Number.isFinite(Number(row.odds_decimal))
      ? modelProb * Number(row.odds_decimal) - 1
      : null;
    return {
      truthSnapshotId: row.id,
      candidateId: row.candidate_id ?? null,
      gameId: row.game_id,
      commenceTime: row.commence_time,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      completeness: dataReadiness.score01,
      mandatoryComplete: Boolean(row.mandatory_complete) && dataReadiness.recommendationAllowed,
      dataReadiness,
      gateStatus: row.candidate_status || row.gate_status,
      gateReasons: JSON.parse(row.gate_reasons_json || '[]'),
      evidence,
      research: {
        market: row.market,
        pick: row.pick,
        oddsDecimal: row.odds_decimal,
        marketProb: row.market_prob,
        modelProb: row.model_prob,
        edge,
        ev,
        status: row.candidate_status,
        rejectionReasons: JSON.parse(row.rejection_reasons_json || '[]'),
      },
      expectedRuns: modelInput.expectedRuns || null,
      // 相容舊欄位：前端逐步改讀 research
      modelOutput: {
        market: row.market,
        pick: row.pick,
        oddsDecimal: row.odds_decimal,
        marketProb: row.market_prob,
        modelProb: row.model_prob,
        edge,
        ev,
        status: row.candidate_status,
        rejectionReasons: JSON.parse(row.rejection_reasons_json || '[]'),
      },
      capturedAt: row.captured_at,
    };
  });

  const formalRanked = attachDailyResearchRanks(mapped);
  const highEvShrinkShadow = buildHighEvShrinkShadowSlate(mapped, formalRanked);
  const afterHighEv = highEvShrinkShadow.ranked || formalRanked;
  const winrateStrongHomeShadow = buildWinrateStrongHomeShadowSlate(
    afterHighEv,
    afterHighEv
  );
  const afterWinrate = winrateStrongHomeShadow.appliesToVisiblePicks
    ? winrateStrongHomeShadow.ranked
    : afterHighEv;
  // 手術 A 預設 off（強主場影子已涵蓋更寬 hwp≥62%）；開 apply 時接在強主場後
  const surgicalAwayStrongEvShadow =
    buildSurgicalAwayStrongEvShadowSlate(afterWinrate);
  const afterSurgicalA =
    surgicalAwayStrongEvShadow.ranked || afterWinrate;
  const surgicalAwayR1MidoddsShadow =
    buildSurgicalAwayR1MidoddsShadowSlate(afterSurgicalA);
  const afterSurgicalB =
    surgicalAwayR1MidoddsShadow.ranked || afterSurgicalA;
  const directionBlendShadow = buildDirectionBlendDisagreeShadowSlate(
    afterSurgicalB,
    afterSurgicalB
  );
  // 方向 blend 僅 compare：正式可看選邊永不吃此影子
  const ranked = afterSurgicalB;
  const topDirections = ranked
    .filter((game) =>
      game.researchTier === 'top1_observation' ||
      game.researchTier === 'top3_observation' ||
      game.researchTier === 'strict_observation'
    )
    .sort((a, b) =>
      String(a.researchDay).localeCompare(String(b.researchDay)) ||
      a.dailyRank - b.dailyRank
    );
  const readyTop = topDirections.filter((game) => game.dataReadiness?.recommendationAllowed);
  const blockedByData = topDirections.filter((game) => !game.dataReadiness?.recommendationAllowed);
  const valueWatch = ranked
    .filter((game) => game.researchTier === 'value_watch')
    .sort((a, b) => {
      const aPick = a.expectedRuns?.moneylineClassification;
      const bPick = b.expectedRuns?.moneylineClassification;
      return (bPick?.expectedValue || 0) - (aPick?.expectedValue || 0) ||
        String(a.commenceTime).localeCompare(String(b.commenceTime));
    });

  function summarizeTopPick(game, index) {
    const pick = game.expectedRuns?.moneylineClassification;
    const readiness = game.dataReadiness;
    return {
      researchDay: game.researchDay,
      dailyRank: game.dailyRank,
      researchTier: game.researchTier,
      rank: game.dailyRank || index + 1,
      gameId: game.gameId,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      commenceTime: game.commenceTime,
      pick: pick?.side === 'home'
        ? game.homeTeam
        : pick?.side === 'away'
          ? game.awayTeam
          : game.research?.pick,
      edge: pick?.edge ?? game.research?.edge ?? null,
      ev: pick?.expectedValue ?? game.research?.ev ?? null,
      modelProb: pick?.modelProbability ?? game.research?.modelProb ?? null,
      marketProb: pick?.marketProbability ?? game.research?.marketProb ?? null,
      modelProbability: pick?.modelProbability ?? game.research?.modelProb ?? null,
      marketProbability: pick?.marketProbability ?? game.research?.marketProb ?? null,
      expectedRunMargin: pick?.expectedRunMargin ?? null,
      expectedValue: pick?.expectedValue ?? game.research?.ev ?? null,
      oddsDecimal: pick?.odds ?? game.research?.oddsDecimal ?? null,
      status: game.research?.status || null,
      recommendationAllowed: Boolean(readiness?.recommendationAllowed),
      dataScorePct: readiness?.scorePct ?? null,
      missingCritical: readiness?.missingCritical || [],
      dataReadiness: readiness || null,
      frozen: false,
      homeWinPct: pick?.homeWinPct ?? null,
      surgicalAwayStrongEvWouldSkip: Boolean(
        pick?.surgicalAwayStrongEvWouldSkip
      ),
      surgicalAwayR1MidoddsWouldSkip: Boolean(
        pick?.surgicalAwayR1MidoddsWouldSkip
      ),
    };
  }

  const topSummariesAll = readyTop.map((game, index) => summarizeTopPick(game, index));
  const nowMs = Date.now();
  const releaseHours = Number(config.mlbLockedBReleaseHoursBefore) || 0;

  // 放出窗內 TopK → 立即紙上 fill（凍結）；已 fill 不受後續 regime/重排影響
  ensureLockedBPaperFillsForReleasedTop(readyTop, nowMs);

  const heldUntilRelease = [];
  for (const row of topSummariesAll) {
    const release = lockedBReleaseWindowMeta(row.commenceTime, nowMs);
    if (hasMlbPaperMoneylineBet(row.gameId)) continue;
    if (
      release.holdReason === `hold_until_t_minus_${releaseHours}h` ||
      release.holdReason?.startsWith('hold_until')
    ) {
      heldUntilRelease.push({ ...row, releaseWindow: release });
    }
  }

  // 可看選邊＝未開賽紙上凍結注（只讀凍結帳）
  const paperPending = listPendingMlbPaperMoneylineBets({ nowMs });
  const topSummaries = paperPending.map((bet, index) => summarizePaperFrozenPick(bet, index));

  /** 同日 2 串：從可看選邊取賠率≤2.10、按排名，至少 2 腿（組合包主串） */
  const PARLAY_LEG_MAX_ODDS = 2.1;
  const parlayLegs = topSummaries
    .filter((row) => Number.isFinite(Number(row.oddsDecimal)) && Number(row.oddsDecimal) <= PARLAY_LEG_MAX_ODDS)
    .sort((a, b) => (a.rank || 99) - (b.rank || 99))
    .slice(0, 2);
  const sameDayParlay =
    parlayLegs.length >= 2
      ? {
          available: true,
          id: 'same_day_ml_2leg',
          label: '同日獨贏 2 串',
          legCount: 2,
          maxLegOdds: PARLAY_LEG_MAX_ODDS,
          suggestedStakeUsd: Number(config.mlbTotalsSatelliteStakeUsd) || 50,
          suggestedStakeNote: '均注 $50（與單場相同）',
          packageRole: 'primary_parlay',
          combinedOdds: Number(
            (parlayLegs[0].oddsDecimal * parlayLegs[1].oddsDecimal).toFixed(3)
          ),
          legs: parlayLegs.map((leg) => ({
            rank: leg.rank,
            gameId: leg.gameId,
            matchup: leg.matchup,
            pick: leg.pick,
            oddsDecimal: leg.oddsDecimal,
          })),
        }
      : {
          available: false,
          id: 'same_day_ml_2leg',
          label: '同日獨贏 2 串',
          legCount: parlayLegs.length,
          maxLegOdds: PARLAY_LEG_MAX_ODDS,
          suggestedStakeUsd: Number(config.mlbTotalsSatelliteStakeUsd) || 50,
          packageRole: 'primary_parlay',
          reason:
            topSummariesAll.length < 2
              ? '今日過門檻場次不足 2，無法組同日 2 串'
              : topSummaries.length < 2
                ? `已過門檻但未滿開賽前 ${releaseHours || 'N'} 小時放出時窗（可看選邊不足 2）`
                : '可看選邊中賠率 ≤ 2.10 的腿不足 2 條',
          legs: parlayLegs.map((leg) => ({
            rank: leg.rank,
            gameId: leg.gameId,
            matchup: leg.matchup,
            pick: leg.pick,
            oddsDecimal: leg.oddsDecimal,
          })),
        };

  /** 大小分衛星（研究影子）：與鎖定 B 獨贏完全分離，不進紙上帳本 */
  /** 大小分衛星：hybrid 主打（均注 $50）；01b both / under-only 作對照 */
  const totalsSatelliteCandidates = ranked.map((game) => {
    const sat = game.expectedRuns?.totalsSatellite;
    if (!sat) return null;
    const day =
      game.researchDay ||
      new Date(game.commenceTime).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Hong_Kong',
      });
    return {
      ...sat,
      researchDay: day,
      gameId: game.gameId,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      commenceTime: game.commenceTime,
      recommendationAllowed: Boolean(game.dataReadiness?.recommendationAllowed),
    };
  }).filter(Boolean);
  const totalsSatellitePicks = selectDailyTotalsSatellitePicks(
    totalsSatelliteCandidates.filter(
      (c) =>
        c.tier === 'actionable' &&
        c.recommendationAllowed &&
        isWithinLockedBReleaseWindow(c.commenceTime, nowMs)
    )
  ).map((c, index) => ({
    rank: index + 1,
    gameId: c.gameId,
    matchup: c.matchup,
    commenceTime: c.commenceTime,
    pick: c.pick,
    side: c.side,
    line: c.line,
    oddsDecimal: c.oddsDecimal,
    modelProbability: c.modelProbability,
    marketProbability: c.marketProbability,
    expectedValue: c.expectedValue,
    absGap: c.absGap,
    expectedTotal: c.expectedTotal,
  }));
  const totalsSatellite = {
    available: totalsSatellitePicks.length > 0,
    researchOnly: true,
    primarySatellite: false,
    specId: MLB_TOTALS_SATELLITE_SPEC.id,
    label: MLB_TOTALS_SATELLITE_SPEC.label,
    note: MLB_TOTALS_SATELLITE_SPEC.note,
    rules: MLB_TOTALS_SATELLITE_SPEC.rules,
    picks: totalsSatellitePicks,
    blockedCount: totalsSatelliteCandidates.filter((c) => c.tier === 'blocked').length,
  };

  const totalsSatelliteUnderOnlyPicks = totalsSatellitePicks
    .filter((c) => c.side === 'under')
    .map((c, index) => ({ ...c, rank: index + 1 }));
  const totalsStakeUsd = Number(config.mlbTotalsSatelliteStakeUsd) || 50;
  const totalsPrimaryMode = String(config.mlbTotalsSatellitePrimary || 'hybrid')
    .trim()
    .toLowerCase();
  const totalsSatelliteUnderOnly = {
    available: totalsSatelliteUnderOnlyPicks.length > 0,
    researchOnly: true,
    primarySatellite: totalsPrimaryMode === 'under',
    suggestedStakeUsd: totalsStakeUsd,
    primaryMode: totalsPrimaryMode,
    specId: MLB_TOTALS_SATELLITE_UNDER_ONLY_SPEC.id,
    label: MLB_TOTALS_SATELLITE_UNDER_ONLY_SPEC.label,
    note: MLB_TOTALS_SATELLITE_UNDER_ONLY_SPEC.note,
    parentSpecId: MLB_TOTALS_SATELLITE_UNDER_ONLY_SPEC.parentSpecId,
    picks: totalsSatelliteUnderOnlyPicks,
  };

  const totalsHybridCandidatesRaw = ranked.map((game) => {
    const sat = game.expectedRuns?.totalsSatelliteHybrid;
    if (!sat) return null;
    const day =
      game.researchDay ||
      new Date(game.commenceTime).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Hong_Kong',
      });
    return {
      ...sat,
      researchDay: day,
      gameId: game.gameId,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      commenceTime: game.commenceTime,
      recommendationAllowed: Boolean(game.dataReadiness?.recommendationAllowed),
    };
  }).filter(Boolean);
  // Under×投手公園：與 FragileUnder（ERA≥5）互補；apply 時不進凍結
  const totalsUnderPitcherShadow = applyTotalsUnderPitcherShadow(
    totalsHybridCandidatesRaw
  );
  const totalsHybridCandidates =
    totalsUnderPitcherShadow.annotated || totalsHybridCandidatesRaw;

  /**
   * Hybrid 日推＝T-8 凍結選邊（對齊回測成交時點）。
   * 活體 EV／盤口漂不再改單、不默默撤「可下」。
   */
  const totalsHybridFrozenRows = [];
  for (const c of totalsHybridCandidates) {
    const release = lockedBReleaseWindowMeta(c.commenceTime, nowMs);
    if (release.holdReason === 'already_started') continue;
    if (!c.recommendationAllowed) continue;
    // 獨贏優先：已有紙上獨贏則不出大小
    if (hasMlbPaperMoneylineBet(c.gameId)) {
      suppressMlbTotalsHybridFreezeForMoneyline(c.gameId);
      continue;
    }

    let freeze = getMlbTotalsHybridFreeze(c.gameId);
    if (!freeze && c.tier === 'actionable' && release.released && c.side) {
      freeze = freezeMlbTotalsHybridOnRelease(c);
    }
    if (!freeze || freeze.status !== 'active') continue;

    totalsHybridFrozenRows.push(
      formatFrozenHybridPick(freeze, c, totalsHybridFrozenRows.length + 1)
    );
  }
  totalsHybridFrozenRows.sort((a, b) =>
    String(a.commenceTime || '').localeCompare(String(b.commenceTime || ''))
  );
  const totalsHybridPicks = selectDailyTotalsSatellitePicks(
    totalsHybridFrozenRows.map((p) => ({
      ...p,
      tier: 'actionable',
      researchDay: new Date(p.commenceTime).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Hong_Kong',
      }),
    })),
    MLB_TOTALS_SATELLITE_HYBRID_SPEC
  ).map((c, index) => ({
    ...c,
    rank: index + 1,
    frozen: true,
  }));

  /** Hybrid：已過閘但未進 T-N 時窗／缺先發 — 只提示狀態不給選邊細節（防過早下） */
  const totalsHybridHeld = totalsHybridCandidates
    .filter(
      (c) =>
        c.tier === 'actionable' &&
        !hasMlbPaperMoneylineBet(c.gameId) &&
        !getMlbTotalsHybridFreeze(c.gameId)
    )
    .map((c) => {
      const release = lockedBReleaseWindowMeta(c.commenceTime, nowMs);
      const ready = Boolean(c.recommendationAllowed);
      let holdReason = null;
      if (!ready) holdReason = 'data_incomplete_pitchers';
      else if (!release.released) holdReason = release.holdReason || 'outside_release_window';
      else holdReason = null;
      if (holdReason === 'already_started') return null;
      if (!holdReason) return null;
      return {
        gameId: c.gameId,
        matchup: c.matchup,
        commenceTime: c.commenceTime,
        hoursUntilCommence: release.hoursUntilCommence,
        holdReason,
      };
    })
    .filter(Boolean);

  /**
   * 凍結政策下：不再用「活體 EV 回撤」當可跟訊號。
   * withdrawn 僅保留空陣列佔位（相容前端）；診斷改看 liveGateWouldBlock。
   */
  const totalsHybridWithdrawn = [];

  /** 今日強訊號但被硬閘擋住（例如盤口>10 的小分）— 說明為何空倉 */
  const totalsHybridBlockedNotable = totalsHybridCandidates
    .filter((c) => {
      if (c.tier === 'actionable') return false;
      const reasons = c.reasons || [];
      const interesting =
        reasons.some((r) => String(r).includes('total_line_above_maximum')) ||
        reasons.some((r) => String(r).includes('fragile_under')) ||
        reasons.some((r) => String(r).includes('totals_under_pitcher')) ||
        Boolean(c.totalsUnderPitcherWouldSkip) ||
        (c.side === 'under' &&
          Number(c.absGap) >= 0.6 &&
          Number(c.expectedValue) >= 0.03);
      return interesting;
    })
    .slice(0, 8)
    .map((c) => ({
      gameId: c.gameId,
      matchup: c.matchup,
      commenceTime: c.commenceTime,
      side: c.side,
      line: c.line,
      absGap: c.absGap,
      expectedValue: c.expectedValue,
      reasons: (c.reasons || [])
        .map((r) => String(r).replace(/^raw:/, '').replace(/^overPath:/, ''))
        .filter((r, i, arr) => arr.indexOf(r) === i)
        .slice(0, 4),
    }));

  const fragileUnderMode = resolveTotalsFragileUnderMode();
  const fragileUnderSkipped = totalsHybridCandidates.filter(
    (c) => c.fragileUnderSkip || c.fragileUnderShadow?.wouldSkip
  );
  const totalsSatelliteHybrid = {
    available: totalsHybridPicks.length > 0,
    researchOnly: false,
    primarySatellite: totalsPrimaryMode === 'hybrid' || totalsPrimaryMode === '',
    suggestedStakeUsd: totalsStakeUsd,
    primaryMode: totalsPrimaryMode,
    specId: MLB_TOTALS_SATELLITE_HYBRID_SPEC.id,
    label: MLB_TOTALS_SATELLITE_HYBRID_SPEC.label,
    note:
      'T-8 首次過閘凍結選邊／盤口／賠率；跟「現在可下」凍結單即可，勿追活體重算。Over EV≥5%；Under EV≥3%。脆弱小分（先發 ERA≥5）與 Under×投手公園可開關屏蔽。',
    fragileUnderShadow: {
      mode: fragileUnderMode,
      specId: MLB_TOTALS_FRAGILE_UNDER_SPEC.id,
      skippedOrWouldSkip: fragileUnderSkipped.length,
      evidence: MLB_TOTALS_FRAGILE_UNDER_SPEC.evidence,
      note: MLB_TOTALS_FRAGILE_UNDER_SPEC.note,
    },
    totalsUnderPitcherShadow: {
      mode: totalsUnderPitcherShadow.mode,
      enabled: totalsUnderPitcherShadow.enabled,
      appliesToVisiblePicks: Boolean(
        totalsUnderPitcherShadow.appliesToVisiblePicks
      ),
      specId: totalsUnderPitcherShadow.spec?.id,
      flagged: (totalsUnderPitcherShadow.flagged || []).slice(0, 12),
      observation: totalsUnderPitcherShadow.observation,
      note:
        totalsUnderPitcherShadow.mode === 'apply'
          ? '正式：Under×投手公園已從 Hybrid 可看選邊剔除'
          : totalsUnderPitcherShadow.mode === 'compare'
            ? 'Under×投手公園觀察中：正式 Hybrid 選邊未改'
            : 'Under×投手公園關閉',
    },
    freezePolicy: MLB_TOTALS_HYBRID_FREEZE_SPEC,
    rules: MLB_TOTALS_SATELLITE_HYBRID_SPEC.rules,
    pitcherParkMuMinusLineOffset:
      MLB_TOTALS_SATELLITE_HYBRID_SPEC.pitcherParkMuMinusLineOffset,
    overMinAbsGap: MLB_TOTALS_SATELLITE_HYBRID_SPEC.overMinAbsGap,
    overMinimumExpectedValue:
      MLB_TOTALS_SATELLITE_HYBRID_SPEC.overMinimumExpectedValue,
    rawOverMaxAbsGap: config.mlbTotalsRawOverMaxAbsGap,
    maxTotalLine: MLB_TOTALS_SATELLITE_HYBRID_SPEC.rules?.maxTotalLine ?? 10,
    picks: totalsHybridPicks,
    held: totalsHybridHeld,
    withdrawn: totalsHybridWithdrawn,
    blockedNotable: totalsHybridBlockedNotable,
    blockedCount: totalsHybridCandidates.filter((c) => c.tier === 'blocked').length,
  };

  const packageStake =
    Number(config.mlbTotalsSatelliteStakeUsd) ||
    MLB_LOCKED_B_PACKAGE.flatStakeUsd ||
    50;
  const parlayStake =
    Number(config.mlbStarParlayStakeUsd) ||
    MLB_LOCKED_B_PACKAGE.parlays.stakeUsd ||
    Math.round(packageStake / 2) ||
    25;
  const lockedBPackage = buildLockedBPackageSnapshot({
    moneylinePicks: topSummaries,
    hybridTotalsPicks: totalsHybridPicks,
    sameDayMlParlay: sameDayParlay,
    stakeUsd: packageStake,
    parlayStakeUsd: parlayStake,
  });

  /** 今日卡關摘要：幫助理解「為什麼場次少」（不改規則） */
  const reasonCounts = {};
  const pitcherGap = {
    missingCritical: 0,
    conflictingIl: 0,
    identityIncomplete: 0,
    strictPitFallback: 0,
    preferredCompleteOverPartial: 0,
  };
  let analyzedReady = 0;
  let pendingCount = 0;
  for (const game of ranked) {
    const pitcherEv = (game.evidence || []).find((e) => e.key === 'starting_pitchers');
    if (pitcherEv?.status === 'conflicting') pitcherGap.conflictingIl += 1;
    if (pitcherEv?.values?.identitySnapshot?.preferredCompleteOverLaterPartial) {
      pitcherGap.preferredCompleteOverPartial += 1;
    }
    const reasons =
      game.expectedRuns?.moneylineClassification?.reasons ||
      game.research?.rejectionReasons ||
      [];
    if (reasons.includes('pitcher_identity_incomplete')) {
      pitcherGap.identityIncomplete += 1;
    }
    if (reasons.includes('strict_pit_starter_required')) {
      pitcherGap.strictPitFallback += 1;
    }

    if (!game.dataReadiness?.recommendationAllowed) {
      pendingCount += 1;
      const miss = game.dataReadiness?.missingCritical?.[0]?.key || 'data_incomplete';
      if (miss === 'starting_pitchers') pitcherGap.missingCritical += 1;
      reasonCounts[miss] = (reasonCounts[miss] || 0) + 1;
      continue;
    }
    analyzedReady += 1;
    if (readyTop.some((g) => g.gameId === game.gameId)) continue;
    const primary = reasons[0] || 'locked_b_excluded';
    reasonCounts[primary] = (reasonCounts[primary] || 0) + 1;
  }
  const todayFunnel = {
    upcoming: ranked.length,
    pendingData: pendingCount,
    analyzedReady,
    selected: topSummaries.length,
    passedGatesHeld: heldUntilRelease.length,
    passedGatesTotal: topSummariesAll.length,
    releaseHoursBefore: releaseHours,
    pitcherGap,
    topReasons: Object.entries(reasonCounts)
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8),
  };

  const snapshotMeta = db.prepare(`
    SELECT MAX(captured_at) AS lastCapturedAt,
           MAX(commence_time) AS lastCommenceTime,
           COUNT(*) AS snapshotCount
    FROM mlb_prematch_truth_snapshots
  `).get();

  return {
    mode: 'research_only',
    modelVersion: resolveFormalModelVersion(),
    strategyVersion: STRATEGY_VERSION,
    inferenceSkeleton: MLB_INFERENCE_FREEZE.skeleton,
    baselineShadowEnabled: config.mlbBaselineShadowEnabled,
    inferenceFreeze: describeMlbInferenceFreeze(),
    dataLag: {
      lastCapturedAt: snapshotMeta?.lastCapturedAt || null,
      lastCommenceTime: snapshotMeta?.lastCommenceTime || null,
      snapshotCount: Number(snapshotMeta?.snapshotCount || 0),
      upcomingGameCount: ranked.length,
      stale: ranked.length === 0,
    },
    disclaimer:
      '此頁僅呈現 MLB 賽前事實與預期得分研究方向（骨架已凍結：兩隊得分→分布→盤口）。Baseline 僅 shadow 不定邊；嚴格方向以勝率與分差為主，EV 只判斷價格；不足場次不湊數，不是投注建議。關鍵資料（賠率／雙方先發／賽程／模型歷史）未齊時不進推薦。可看選邊僅在開賽前時窗內放出。',
    releasePolicy: {
      hoursBefore: releaseHours,
      enabled: releaseHours > 0,
      note:
        releaseHours > 0
          ? `僅開賽前 ${releaseHours} 小時內放出可看選邊／紙上晉升／串關提示`
          : '放出時窗關閉（過門檻即顯示）',
    },
    highEvShrinkShadow: {
      mode: highEvShrinkShadow.mode,
      enabled: highEvShrinkShadow.enabled,
      appliesToVisiblePicks: Boolean(highEvShrinkShadow.appliesToVisiblePicks),
      specId: highEvShrinkShadow.spec?.id,
      diff: highEvShrinkShadow.diff,
      shadowDailyTop: (highEvShrinkShadow.shadowTop || []).slice(0, 12),
      formalDailyTop: (highEvShrinkShadow.formalTop || []).slice(0, 12),
      observation: highEvShrinkShadow.observation,
      note:
        highEvShrinkShadow.mode === 'apply'
          ? '影子 overlay 已套用至下方可看選邊（非升格常數）'
          : highEvShrinkShadow.mode === 'compare'
            ? '影子對照中：下方可看選邊仍為鎖定 B；差異見 shadowDailyTop'
            : '影子 overlay 關閉',
    },
    winrateStrongHomeShadow: {
      mode: winrateStrongHomeShadow.mode,
      enabled: winrateStrongHomeShadow.enabled,
      appliesToVisiblePicks: Boolean(winrateStrongHomeShadow.appliesToVisiblePicks),
      action: winrateStrongHomeShadow.action,
      specId: winrateStrongHomeShadow.spec?.id,
      diff: winrateStrongHomeShadow.diff,
      shadowDailyTop: (winrateStrongHomeShadow.shadowTop || []).slice(0, 12),
      evidence: winrateStrongHomeShadow.spec?.evidence || null,
      note:
        winrateStrongHomeShadow.mode === 'apply'
          ? '提勝率：強主場推客（hwp≥62%＋EV≥10%）已改推主／剔除'
          : winrateStrongHomeShadow.mode === 'compare'
            ? '提勝率影子對照中：可看選邊未改；見 diff'
            : '提勝率強主影子關閉',
    },
    surgicalAwayStrongEvShadow: {
      mode: surgicalAwayStrongEvShadow.mode,
      enabled: surgicalAwayStrongEvShadow.enabled,
      appliesToVisiblePicks: Boolean(
        surgicalAwayStrongEvShadow.appliesToVisiblePicks
      ),
      specId: surgicalAwayStrongEvShadow.spec?.id,
      flagged: (surgicalAwayStrongEvShadow.flagged || []).slice(0, 12),
      diff: surgicalAwayStrongEvShadow.diff,
      observation: surgicalAwayStrongEvShadow.observation,
      note:
        surgicalAwayStrongEvShadow.mode === 'apply'
          ? '手術 A 已從可看選邊剔除（預設 off；優先用強主場影子）'
          : surgicalAwayStrongEvShadow.mode === 'compare'
            ? '手術 A 觀察中：正式選邊不變'
            : '手術 A 關閉（由 WINRATE_STRONG_HOME 承接）',
    },
    surgicalAwayR1MidoddsShadow: {
      mode: surgicalAwayR1MidoddsShadow.mode,
      enabled: surgicalAwayR1MidoddsShadow.enabled,
      appliesToVisiblePicks: Boolean(
        surgicalAwayR1MidoddsShadow.appliesToVisiblePicks
      ),
      specId: surgicalAwayR1MidoddsShadow.spec?.id,
      flagged: (surgicalAwayR1MidoddsShadow.flagged || []).slice(0, 12),
      diff: surgicalAwayR1MidoddsShadow.diff,
      observation: surgicalAwayR1MidoddsShadow.observation,
      note:
        surgicalAwayR1MidoddsShadow.mode === 'apply'
          ? '正式：手術 B 已從可看選邊剔除（客R1中水）'
          : surgicalAwayR1MidoddsShadow.mode === 'compare'
            ? '手術 B 觀察中：正式選邊不變'
            : '手術 B 關閉',
    },
    directionBlendShadow: {
      mode: directionBlendShadow.mode,
      enabled: directionBlendShadow.enabled,
      appliesToVisiblePicks: false,
      specId: directionBlendShadow.spec?.id,
      logisticFreezeLoaded: Boolean(directionBlendShadow.logisticFreezeLoaded),
      diff: (directionBlendShadow.diff || []).slice(0, 20),
      slotDiff: directionBlendShadow.slotDiff || null,
      shadowDailyTop: (directionBlendShadow.shadowTop || []).slice(0, 12),
      formalDailyTop: (directionBlendShadow.formalTop || []).slice(0, 12),
      evidence: directionBlendShadow.evidence || null,
      note: directionBlendShadow.note || '方向 blend 影子',
    },
    dailyTop: topSummaries,
    expectedRunsTop: topSummaries,
    heldUntilRelease: heldUntilRelease.map((row) => ({
      gameId: row.gameId,
      matchup: row.matchup,
      commenceTime: row.commenceTime,
      rank: row.rank,
      pick: row.pick,
      oddsDecimal: row.oddsDecimal,
      hoursUntilCommence: row.releaseWindow?.hoursUntilCommence ?? null,
      releaseHoursBefore: releaseHours,
      holdReason: row.releaseWindow?.holdReason || 'held',
    })),
    sameDayParlay,
    lockedBPackage,
    totalsSatellite,
    totalsSatelliteUnderOnly,
    totalsSatelliteHybrid,
    todayFunnel,
    blockedByData: blockedByData.map((game, index) => summarizeTopPick(game, index)),
    valueWatch: valueWatch.map((game) => {
      const pick = game.expectedRuns.moneylineClassification;
      const readiness = game.dataReadiness;
      return {
        gameId: game.gameId,
        matchup: `${game.awayTeam} @ ${game.homeTeam}`,
        commenceTime: game.commenceTime,
        pick: pick.side === 'home' ? game.homeTeam : game.awayTeam,
        modelProbability: pick.modelProbability,
        marketProbability: pick.marketProbability,
        expectedRunMargin: pick.expectedRunMargin,
        expectedValue: pick.expectedValue,
        oddsDecimal: pick.odds,
        reasons: pick.reasons || [],
        recommendationAllowed: Boolean(readiness?.recommendationAllowed),
        dataScorePct: readiness?.scorePct ?? null,
        missingCritical: readiness?.missingCritical || [],
      };
    }),
    games: ranked,
  };
}

/**
 * 路徑 γ：把當日鎖定 B 日內名額（TopK+dropR3/R2）從 research_observation
 * 晉升為 paper_candidate，供 MlbPaperLedger 建注。不改選注常數。
 *
 * 僅處理尚未開賽、關鍵資料齊全（含雙方先發）、有 pick/odds 的最新 snapshot 候補。
 */
export function promoteDailyLockedBPaperCandidates({ lookbackDays = 1, lookaheadDays = 3 } = {}) {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - Math.max(0, Number(lookbackDays) || 0));
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + Math.max(1, Number(lookaheadDays) || 3));

  const slate = getMlbPrematchTruthSlate({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const paperTiers = new Set(['top1_observation', 'top3_observation']);
  const now = Date.now();
  const update = db.prepare(`
    UPDATE mlb_paper_candidates
    SET status = 'paper_candidate',
        rejection_reasons_json = ?
    WHERE id = ?
      AND status IN ('research_observation', 'value_watch', 'no_signal')
  `);

  let promoted = 0;
  let skipped = 0;
  const promotedGameIds = [];

  for (const game of slate.games || []) {
    if (!paperTiers.has(game.researchTier)) {
      skipped += 1;
      continue;
    }
    if (
      !game.candidateId ||
      !game.mandatoryComplete ||
      !game.dataReadiness?.recommendationAllowed
    ) {
      skipped += 1;
      continue;
    }
    if (!game.research?.pick || !Number.isFinite(Number(game.research?.oddsDecimal))) {
      skipped += 1;
      continue;
    }
    const commenceMs = Date.parse(game.commenceTime);
    if (Number.isFinite(commenceMs) && commenceMs <= now) {
      skipped += 1;
      continue;
    }
    if (!isWithinLockedBReleaseWindow(game.commenceTime, now)) {
      skipped += 1;
      continue;
    }
    const reasons = [
      ...(Array.isArray(game.research?.rejectionReasons)
        ? game.research.rejectionReasons
        : []),
      'path_gamma_locked_b_daily_slot',
      `daily_rank_${game.dailyRank}`,
      ...(Number(config.mlbLockedBReleaseHoursBefore) > 0
        ? [`release_within_${config.mlbLockedBReleaseHoursBefore}h`]
        : []),
    ];
    const result = update.run(JSON.stringify(reasons), game.candidateId);
    if (result.changes === 1) {
      promoted += 1;
      promotedGameIds.push(game.gameId);
      createPaperBetFromCandidate(game.candidateId);
      suppressMlbTotalsHybridFreezeForMoneyline(game.gameId);
    } else {
      skipped += 1;
    }
  }

  return {
    mode: 'path_gamma_promote',
    profile: config.mlbPaperRuleProfile,
    scanned: (slate.games || []).length,
    promoted,
    skipped,
    promotedGameIds,
  };
}

