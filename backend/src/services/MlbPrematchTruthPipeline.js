/**
 * MLB 賽前真實資料管線。
 *
 * 此模組刻意不讀取舊 recommendations、tier、flat_bet 或建議注碼。
 * 它只保存可追溯的賽前事實、資料缺口與研究用模型輸出；在策略通過
 * 樣本外驗證前，任何場次都不能成為可實投訊號。
 */
import db from '../db/database.js';
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
  getMlbPitcherPregameFeatures,
  getMlbPitcherRecentStartFeatures,
} from './MlbStatsService.js';
import { randomUUID } from 'crypto';
import { decimalToImpliedProb, removeVig } from '../utils/odds.js';
import { config } from '../config.js';
import { getExternalLineupEvidence } from './ExternalPrematchSnapshotService.js';
import {
  buildMlbTeamFeatureStateAt,
  composeMlbFeatureVector,
  getLatestMlbBaselineModel,
  predictMlbBaseline,
} from './MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
} from './MlbExpectedRunsModel.js';
import {
  recordMlbProbableStarterSnapshot,
  resolveMlbProbableStarterSnapshot,
} from './MlbProbableStarterService.js';
import {
  attachDailyResearchRanks,
  selectResearchDirection,
} from './MlbResearchRanker.js';
import { resolvePitOdds } from './PitOddsService.js';

const MODEL_VERSION = 'mlb-foundation-pit-v1';
const STRATEGY_VERSION = 'mlb-research-rank-v1';
const EVIDENCE_VERSION = 'mlb-prematch-evidence-v4';

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
  const weights = {
    fixture: 1,
    odds: 2,
    venue: 1,
    starting_pitchers: 2,
    official_history: 2,
    model_history: 2,
    bullpen: 2,
    lineup: 2,
    injuries: 1,
    park: 1,
    weather: 1,
    travel_rest: 1,
  };
  let weight = 0;
  let covered = 0;
  for (const item of items) {
    const w = weights[item.key] ?? 1;
    weight += w;
    covered += w * stateScore(item.status);
  }
  return weight ? Math.round((covered / weight) * 1000) / 1000 : 0;
}

/**
 * 從同一 bookmaker 取得雙邊 h2h，避免把不同莊家的最佳價格拼成假去水概率。
 */
export function bestFairH2h(bookmakers, homeTeam, awayTeam) {
  let selected = null;
  for (const book of bookmakers) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    const home = market?.outcomes?.find((o) => o.name === homeTeam);
    const away = market?.outcomes?.find((o) => o.name === awayTeam);
    if (!home?.price || !away?.price) continue;
    const homeImplied = decimalToImpliedProb(home.price);
    const awayImplied = decimalToImpliedProb(away.price);
    if (!homeImplied || !awayImplied) continue;
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
  return selected;
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

async function collectWeather(venue, commenceTime) {
  const coordinates = coordinateFromVenue(venue);
  if (!coordinates) return null;
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', coordinates.latitude);
    url.searchParams.set('longitude', coordinates.longitude);
    url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m');
    url.searchParams.set('timezone', 'UTC');
    const response = await fetch(url);
    if (!response.ok) return null;
    const forecast = await response.json();
    const target = new Date(commenceTime).toISOString().slice(0, 13);
    const index = (forecast.hourly?.time || []).findIndex((time) => String(time).slice(0, 13) === target);
    if (index < 0) return null;
    return {
      coordinates,
      temperatureC: forecast.hourly.temperature_2m?.[index] ?? null,
      precipitationProbability: forecast.hourly.precipitation_probability?.[index] ?? null,
      windSpeedKph: forecast.hourly.wind_speed_10m?.[index] ?? null,
      windDirection: forecast.hourly.wind_direction_10m?.[index] ?? null,
      forecastTime: forecast.hourly.time?.[index] ?? null,
    };
  } catch {
    return null;
  }
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
  const pitchers = getProbablePitchers(official);
  const starterCapturedAt = nowIso();
  recordMlbProbableStarterSnapshot({
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
      getMlbPitcherPregameFeatures(pitchers.home?.id, game.commence_time, pitOptions),
      getMlbPitcherPregameFeatures(pitchers.away?.id, game.commence_time, pitOptions),
      getMlbPitcherRecentStartFeatures(pitchers.home?.id, game.commence_time, pitOptions),
      getMlbPitcherRecentStartFeatures(pitchers.away?.id, game.commence_time, pitOptions),
    ]);
  const [weather, officialHomeLineup, officialAwayLineup, homeBullpen, awayBullpen, homeRest, awayRest] = await Promise.all([
    collectWeather(venue, game.commence_time),
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
      'park',
      venueName ? 'partial' : 'missing',
      venueName && venue
        ? {
            summary: `已確認球場 ${venueName}；場地係數資料尚未驗證`,
            source: 'MLB Stats API venue',
            sourceRef: String(venueId || ''),
            values: {
              roofType: venue.fieldInfo?.roofType ?? null,
              turfType: venue.fieldInfo?.turfType ?? null,
            },
            capturedAt,
            reason: 'park_factor_dataset_not_implemented',
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
            source: 'Open-Meteo hourly forecast',
            values: weather,
            capturedAt,
            validUntil: oddsExpiry,
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

  const baseline = getLatestMlbBaselineModel();
  const requiresPitcher = baseline?.model?.featureKeys?.some((key) => key.startsWith('pitcher')) === true;
  const requiresBullpen = baseline?.model?.featureKeys?.some((key) => key.startsWith('bullpen')) === true;
  const mandatory = ['fixture', 'odds', 'model_history'];
  const mandatoryFailures = items
    .filter((item) => mandatory.includes(item.key) && item.status !== 'verified')
    .map((item) => `${item.key}:${item.status}`);
  if (requiresPitcher) {
    const pitcherEvidence = items.find((item) => item.key === 'starting_pitchers');
    if (!['verified', 'partial'].includes(pitcherEvidence?.status)) {
      mandatoryFailures.push(`starting_pitchers:${pitcherEvidence?.status || 'missing'}`);
    }
  }
  if (requiresBullpen) {
    const bullpenEvidence = items.find((item) => item.key === 'bullpen');
    if (!['verified', 'partial'].includes(bullpenEvidence?.status)) {
      mandatoryFailures.push(`bullpen:${bullpenEvidence?.status || 'missing'}`);
    }
  }
  const pitcherEvidence = items.find((item) => item.key === 'starting_pitchers');
  if (pitcherEvidence) pitcherEvidence.usedInModel = requiresPitcher;
  const bullpenEvidence = items.find((item) => item.key === 'bullpen');
  if (bullpenEvidence) bullpenEvidence.usedInModel = requiresBullpen;
  const featureVector = composeMlbFeatureVector(
    modelTeamHistory.vector,
    homePitcherHistory,
    awayPitcherHistory,
    homePitcherRecent,
    awayPitcherRecent,
    homeBullpen,
    awayBullpen
  );
  const baselineFeaturesAvailable =
    baseline &&
    featureVector &&
    baseline.model.featureKeys.every((key) => Number.isFinite(featureVector[key]));
  const baselineHomeProb = baselineFeaturesAvailable
    ? predictMlbBaseline(baseline.model, featureVector)
    : null;
  if (baselineHomeProb == null) {
    mandatoryFailures.push(
      baseline ? 'baseline_features:missing' : 'baseline_model:missing'
    );
  }
  const shadowModels = Object.fromEntries(
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
        homeProb: !conflictBlocked && featuresAvailable
          ? predictMlbBaseline(model, featureVector)
          : null,
        awayProb: !conflictBlocked && featuresAvailable
          ? 1 - predictMlbBaseline(model, featureVector)
          : null,
        deployable: challenger.deployable === true,
        blockReason: conflictBlocked
          ? 'probable_pitcher_conflicts_with_injury_list'
          : challenger.blockReason ?? null,
      }];
    })
  );
  const expectedRunsModel = getLatestMlbExpectedRunsValidation();
  const expectedRunsFeatures = {
    home: modelTeamHistory.home,
    away: modelTeamHistory.away,
    pitchers: {
      home: homePitcherHistory,
      away: awayPitcherHistory,
      homeRecent: homePitcherRecent,
      awayRecent: awayPitcherRecent,
    },
    recentBoxscore: {
      home: {
        batting: homeOfficialHistory?.offense
          ? {
              gamesObserved: homeOfficialHistory.offense.games,
              obp: homeOfficialHistory.offense.obp,
              slg: homeOfficialHistory.offense.slg,
              kRate: null,
              bbRate: null,
            }
          : null,
      },
      away: {
        batting: awayOfficialHistory?.offense
          ? {
              gamesObserved: awayOfficialHistory.offense.games,
              obp: awayOfficialHistory.offense.obp,
              slg: awayOfficialHistory.offense.slg,
              kRate: null,
              bbRate: null,
            }
          : null,
      },
    },
  };
  const strictStarterIdentity =
    starterIdentitySnapshot.ok &&
    starterIdentitySnapshot.status === 'complete' &&
    starterInjuryConflicts.length === 0;
  const selectedExpectedRunsModel = strictStarterIdentity
    ? expectedRunsModel?.model
    : expectedRunsModel?.model?.fallbackModel;
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
        prediction: predictMlbGameRuns(
          selectedExpectedRunsModel,
          expectedRunsFeatures
        ),
      }
    : {
        status: 'blocked_model_missing',
        modelVersion: expectedRunsModel?.modelVersion ?? null,
        trainedAt: expectedRunsModel?.createdAt ?? null,
        starterIdentity: starterIdentitySnapshot,
        featureMode: null,
        prediction: null,
      };

  return {
    items,
    market,
    baseline: baselineHomeProb == null
      ? null
      : {
          featureVersion: baseline.featureVersion,
          trainedAt: baseline.createdAt,
          metrics: baseline.metrics,
          featureVector,
          homeProb: baselineHomeProb,
          awayProb: 1 - baselineHomeProb,
          shadowModels,
        },
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
      model: MODEL_VERSION,
      strategy: STRATEGY_VERSION,
      baseline: truth.baseline
        ? {
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
    truth.baseline
      ? JSON.stringify({
          featureVersion: truth.baseline.featureVersion,
          trainedAt: truth.baseline.trainedAt,
          featureVector: truth.baseline.featureVector,
          homeProb: truth.baseline.homeProb,
          awayProb: truth.baseline.awayProb,
          shadowModels: truth.baseline.shadowModels,
          expectedRuns: truth.expectedRuns,
        })
      : null
  ).lastInsertRowid;
}

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
  const model = truth.baseline;
  const selection = model && market
    ? selectResearchDirection({
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        homeModelProb: Number(model.homeProb),
        awayModelProb: Number(model.awayProb),
        market,
      })
    : null;
  const pick = selection?.pick ?? null;
  const odds = selection?.oddsDecimal ?? null;
  const marketProb = selection?.marketProb ?? null;
  const modelProb = selection?.modelProb ?? null;
  const selectedEdge = selection?.edge ?? null;
  const hasIndependentSignal =
    Number.isFinite(selectedEdge) &&
    selectedEdge >= config.mlbBaselineMinMarketGap;
  const rejectionReasons = [
    ...truth.gateReasons,
    ...(model ? [] : ['baseline_model_or_features_missing']),
    ...(model && !hasIndependentSignal ? ['baseline_market_gap_below_threshold'] : []),
  ];
  // 正式推薦已停用：有正 edge 只標記為研究方向觀察，不建立可下注候選。
  const status = !truth.mandatoryComplete
    ? 'blocked_data'
    : !model
      ? 'blocked_model'
      : !hasIndependentSignal
        ? 'no_signal'
        : 'research_observation';
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
    MODEL_VERSION,
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
    modelVersion: MODEL_VERSION,
    strategyVersion: STRATEGY_VERSION,
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

export function getMlbPrematchTruthSlate({ from, to } = {}) {
  const rows = latestTruthRows({ from, to });
  const mapped = rows.map((row) => {
    const modelInput = JSON.parse(row.model_input_json || '{}');
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
      gameId: row.game_id,
      commenceTime: row.commence_time,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      completeness: row.completeness,
      mandatoryComplete: Boolean(row.mandatory_complete),
      gateStatus: row.candidate_status || row.gate_status,
      gateReasons: JSON.parse(row.gate_reasons_json || '[]'),
      evidence: JSON.parse(row.evidence_json || '[]'),
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

  const ranked = attachDailyResearchRanks(mapped);
  const topDirections = ranked
    .filter((game) => game.researchTier === 'top1_observation' || game.researchTier === 'top3_observation')
    .sort((a, b) => String(a.researchDay).localeCompare(String(b.researchDay)) || a.dailyRank - b.dailyRank);

  return {
    mode: 'research_only',
    modelVersion: MODEL_VERSION,
    strategyVersion: STRATEGY_VERSION,
    disclaimer:
      '此頁僅呈現 MLB 賽前事實、獨立模型概率與市場錯價排序。Top1/Top3 是研究方向，不是投注建議。',
    dailyTop: topDirections.map((game) => ({
      researchDay: game.researchDay,
      dailyRank: game.dailyRank,
      researchTier: game.researchTier,
      gameId: game.gameId,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      commenceTime: game.commenceTime,
      pick: game.research?.pick || null,
      edge: game.research?.edge ?? null,
      ev: game.research?.ev ?? null,
      modelProb: game.research?.modelProb ?? null,
      marketProb: game.research?.marketProb ?? null,
      oddsDecimal: game.research?.oddsDecimal ?? null,
      status: game.research?.status || null,
    })),
    games: ranked,
  };
}

