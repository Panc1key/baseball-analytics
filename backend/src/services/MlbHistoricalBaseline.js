/**
 * MLB 歷史基準模型。
 *
 * 特徵只由開賽前已結束的庫內賽果推導，不使用賽後打線、天氣、賠率或熱門度。
 * 這是用來檢驗隊級歷史資訊是否優於 50/50 的研究基準，不是下注策略。
 */
import db from '../db/database.js';
import {
  getMlbGameBoxscore,
  getMlbPitcherPregameFeaturesFromGameLog,
  getMlbPitcherRecentStartFeatures,
  getMlbScheduleAround,
  matchMlbOfficialGame,
} from './MlbStatsService.js';
import { resolveMlbProbableStarterSnapshot } from './MlbProbableStarterService.js';

export const MLB_BASELINE_FEATURE_VERSION = 'mlb-foundation-pit-v1';
export const MLB_TEAM_FEATURE_KEYS = [
  'seasonWinPctDiff',
  'venueRecordDiff',
  'last10WinPctDiff',
  'recentRunsDiff',
  'recentRunsAllowedDiff',
];
const FEATURE_KEYS = MLB_TEAM_FEATURE_KEYS;
const PITCHER_FEATURE_KEYS = [
  'pitcherEraDiff',
  'pitcherWhipDiff',
  'pitcherK9Diff',
  'pitcherBb9Diff',
];
const RECENT_PITCHER_FEATURE_KEYS = [
  'pitcherRestDaysDiff',
  'pitcherRecentEraDiff',
  'pitcherRecentK9Diff',
  'pitcherRecentBb9Diff',
  'pitcherRecentPitchesDiff',
];
export const MLB_FOUNDATION_FEATURE_KEYS = [
  'seasonWinPctDiff',
  'venueRecordDiff',
  'recentRunsDiff',
  'recentRunsAllowedDiff',
  'pitcherEraDiff',
  'pitcherWhipDiff',
  'pitcherKMinusBb9Diff',
  'pitcherRecentEraDiff',
  'pitcherRestDaysDiff',
  'pitcherRecentPitchesDiff',
];
export const MLB_FOUNDATION_TEAM_FEATURE_KEYS = MLB_FOUNDATION_FEATURE_KEYS.slice(0, 4);
const BULLPEN_FEATURE_KEYS = [
  'bullpenPitchesLast3Diff',
  'bullpenAppearancesLast3Diff',
];
export const MLB_RECENT_BATTING_FEATURE_KEYS = [
  'battingObp14Diff',
  'battingSlg14Diff',
  'battingKRate14Diff',
  'battingBbRate14Diff',
];
export const MLB_BULLPEN_QUALITY_FEATURE_KEYS = [
  'bullpenEra7Diff',
  'bullpenWhip7Diff',
  'bullpenKMinusBb7Diff',
  'bullpenHr9Diff',
];

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function inningsToOuts(value) {
  const match = String(value ?? '').match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return 0;
  const partial = Number(match[2] || 0);
  if (partial > 2) return 0;
  return Number(match[1]) * 3 + partial;
}

function winPct(wins, losses) {
  const games = wins + losses;
  return games ? wins / games : 0.5;
}

function emptyTeam() {
  return {
    wins: 0,
    losses: 0,
    homeWins: 0,
    homeLosses: 0,
    awayWins: 0,
    awayLosses: 0,
    results: [],
  };
}

function recentGames(team, commenceTime, days = 30) {
  const cutoff = Date.parse(commenceTime) - days * 24 * 60 * 60 * 1000;
  return team.results.filter((entry) => Date.parse(entry.commenceTime) < Date.parse(commenceTime) &&
    Date.parse(entry.commenceTime) >= cutoff);
}

function teamFeature(team, commenceTime) {
  const last10 = team.results.slice(-10);
  const recent = recentGames(team, commenceTime);
  const average = (entries, field) =>
    entries.length ? entries.reduce((sum, entry) => sum + entry[field], 0) / entries.length : 0;
  return {
    wins: team.wins,
    losses: team.losses,
    homeWins: team.homeWins,
    homeLosses: team.homeLosses,
    awayWins: team.awayWins,
    awayLosses: team.awayLosses,
    seasonWinPct: winPct(team.wins, team.losses),
    homeWinPct: winPct(team.homeWins, team.homeLosses),
    awayWinPct: winPct(team.awayWins, team.awayLosses),
    last10WinPct: last10.length ? average(last10, 'won') : 0.5,
    recentRunsPerGame: recent.length ? average(recent, 'runsFor') : 0,
    recentRunsAllowedPerGame: recent.length ? average(recent, 'runsAgainst') : 0,
    recentGames: recent.length,
  };
}

export function buildMlbTeamFeatureVector(home, away) {
  return {
    seasonWinPctDiff: home.seasonWinPct - away.seasonWinPct,
    venueRecordDiff: home.homeWinPct - away.awayWinPct,
    last10WinPctDiff: home.last10WinPct - away.last10WinPct,
    recentRunsDiff: home.recentRunsPerGame - away.recentRunsPerGame,
    recentRunsAllowedDiff: away.recentRunsAllowedPerGame - home.recentRunsAllowedPerGame,
  };
}

function pitcherVector(home, away) {
  if (!home || !away) return null;
  const required = [
    home.era, home.whip, home.strikeoutsPer9, home.walksPer9,
    away.era, away.whip, away.strikeoutsPer9, away.walksPer9,
  ];
  if (!required.every((value) => Number.isFinite(Number(value)))) return null;
  return {
    pitcherEraDiff: finite(away.era) - finite(home.era),
    pitcherWhipDiff: finite(away.whip) - finite(home.whip),
    pitcherK9Diff: finite(home.strikeoutsPer9) - finite(away.strikeoutsPer9),
    pitcherBb9Diff: finite(away.walksPer9) - finite(home.walksPer9),
    pitcherKMinusBb9Diff:
      finite(home.strikeoutsPer9) - finite(home.walksPer9) -
      (finite(away.strikeoutsPer9) - finite(away.walksPer9)),
  };
}

function recentPitcherVector(home, away) {
  if (!home || !away) return null;
  const required = [
    home.restDays, home.recent3Era, home.recent3K9, home.recent3BB9, home.recent3PitchesPerStart,
    away.restDays, away.recent3Era, away.recent3K9, away.recent3BB9, away.recent3PitchesPerStart,
  ];
  if (!required.every((value) => Number.isFinite(Number(value)))) return null;
  return {
    pitcherRestDaysDiff: finite(home.restDays) - finite(away.restDays),
    pitcherRecentEraDiff: finite(away.recent3Era) - finite(home.recent3Era),
    pitcherRecentK9Diff: finite(home.recent3K9) - finite(away.recent3K9),
    pitcherRecentBb9Diff: finite(away.recent3BB9) - finite(home.recent3BB9),
    pitcherRecentPitchesDiff: finite(away.recent3PitchesPerStart) - finite(home.recent3PitchesPerStart),
  };
}

export function buildBullpenWorkloadVector(home, away) {
  if (!home || !away) return null;
  const required = [
    home.pitchesLast3,
    home.appearancesLast3,
    away.pitchesLast3,
    away.appearancesLast3,
  ];
  if (!required.every((value) => Number.isFinite(Number(value)))) return null;
  return {
    bullpenPitchesLast3Diff: finite(away.pitchesLast3) - finite(home.pitchesLast3),
    bullpenAppearancesLast3Diff:
      finite(away.appearancesLast3) - finite(home.appearancesLast3),
  };
}

export function buildRecentBoxscoreVector(home, away) {
  if (!home?.batting || !away?.batting || !home?.bullpen || !away?.bullpen) return null;
  const required = [
    home.batting.obp,
    home.batting.slg,
    home.batting.kRate,
    home.batting.bbRate,
    away.batting.obp,
    away.batting.slg,
    away.batting.kRate,
    away.batting.bbRate,
    home.bullpen.era,
    home.bullpen.whip,
    home.bullpen.kMinusBbRate,
    home.bullpen.hr9,
    away.bullpen.era,
    away.bullpen.whip,
    away.bullpen.kMinusBbRate,
    away.bullpen.hr9,
  ];
  if (!required.every((value) => Number.isFinite(Number(value)))) return null;
  return {
    battingObp14Diff: finite(home.batting.obp) - finite(away.batting.obp),
    battingSlg14Diff: finite(home.batting.slg) - finite(away.batting.slg),
    battingKRate14Diff: finite(away.batting.kRate) - finite(home.batting.kRate),
    battingBbRate14Diff: finite(home.batting.bbRate) - finite(away.batting.bbRate),
    bullpenEra7Diff: finite(away.bullpen.era) - finite(home.bullpen.era),
    bullpenWhip7Diff: finite(away.bullpen.whip) - finite(home.bullpen.whip),
    bullpenKMinusBb7Diff:
      finite(home.bullpen.kMinusBbRate) - finite(away.bullpen.kMinusBbRate),
    bullpenHr9Diff: finite(away.bullpen.hr9) - finite(home.bullpen.hr9),
  };
}

function battingUsageFromBoxscore(boxscore, side) {
  const batting = boxscore?.teams?.[side]?.teamStats?.batting;
  if (!batting) return null;
  return {
    atBats: finite(batting.atBats),
    hits: finite(batting.hits),
    walks: finite(batting.baseOnBalls),
    hitByPitch: finite(batting.hitByPitch),
    sacrificeFlies: finite(batting.sacFlies),
    strikeouts: finite(batting.strikeOuts),
    totalBases: finite(batting.totalBases),
  };
}

function bullpenUsageFromBoxscore(boxscore, side) {
  const team = boxscore?.teams?.[side];
  if (!team?.pitchers?.length) return null;
  const starterId = team.pitchers[0];
  let appearances = 0;
  let pitches = 0;
  let outs = 0;
  let hits = 0;
  let walks = 0;
  let strikeouts = 0;
  let earnedRuns = 0;
  let homeRuns = 0;
  for (const pitcherId of team.pitchers) {
    if (pitcherId === starterId) continue;
    const pitching = team.players?.[`ID${pitcherId}`]?.stats?.pitching;
    if (!pitching) continue;
    appearances += 1;
    pitches += finite(pitching.pitchesThrown);
    outs += inningsToOuts(pitching.inningsPitched);
    hits += finite(pitching.hits);
    walks += finite(pitching.baseOnBalls);
    strikeouts += finite(pitching.strikeOuts);
    earnedRuns += finite(pitching.earnedRuns);
    homeRuns += finite(pitching.homeRuns);
  }
  return { appearances, pitches, outs, hits, walks, strikeouts, earnedRuns, homeRuns };
}

function bullpenHistorySummary(history) {
  if (!history || history.length < 3) return null;
  const last3 = history.slice(-3);
  return {
    gamesObserved: 3,
    appearancesLast3: last3.reduce((sum, game) => sum + game.appearances, 0),
    pitchesLast3: last3.reduce((sum, game) => sum + game.pitches, 0),
  };
}

function sumHistory(history, fields) {
  return Object.fromEntries(fields.map((field) => [
    field,
    history.reduce((sum, game) => sum + finite(game[field]), 0),
  ]));
}

function recentBattingSummary(history) {
  if (!history || history.length < 10) return null;
  const totals = sumHistory(history.slice(-14), [
    'atBats',
    'hits',
    'walks',
    'hitByPitch',
    'sacrificeFlies',
    'strikeouts',
    'totalBases',
  ]);
  const plateAppearances =
    totals.atBats + totals.walks + totals.hitByPitch + totals.sacrificeFlies;
  if (totals.atBats <= 0 || plateAppearances <= 0) return null;
  return {
    gamesObserved: Math.min(14, history.length),
    obp:
      (totals.hits + totals.walks + totals.hitByPitch) / plateAppearances,
    slg: totals.totalBases / totals.atBats,
    kRate: totals.strikeouts / plateAppearances,
    bbRate: totals.walks / plateAppearances,
  };
}

function bullpenQualitySummary(history) {
  if (!history || history.length < 5) return null;
  const last7 = history.slice(-7);
  const totals = sumHistory(last7, [
    'outs',
    'hits',
    'walks',
    'strikeouts',
    'earnedRuns',
    'homeRuns',
  ]);
  const battersFaced = totals.outs + totals.hits + totals.walks;
  if (totals.outs <= 0 || battersFaced <= 0) return null;
  return {
    gamesObserved: last7.length,
    era: (totals.earnedRuns * 27) / totals.outs,
    whip: ((totals.hits + totals.walks) * 3) / totals.outs,
    kMinusBbRate: (totals.strikeouts - totals.walks) / battersFaced,
    hr9: (totals.homeRuns * 27) / totals.outs,
  };
}

function updateTeam(team, { isHome, won, runsFor, runsAgainst, commenceTime }) {
  if (won) team.wins += 1;
  else team.losses += 1;
  if (isHome) {
    if (won) team.homeWins += 1;
    else team.homeLosses += 1;
  } else if (won) {
    team.awayWins += 1;
  } else {
    team.awayLosses += 1;
  }
  team.results.push({ won: won ? 1 : 0, runsFor, runsAgainst, commenceTime });
}

function isMlbRegularSeasonTeam(name) {
  const team = String(name || '');
  if (!team) return false;
  if (team === 'American League' || team === 'National League') return false;
  if (/All[- ]?Star/i.test(team)) return false;
  return true;
}

function completedMlbGames({ from = null, to = null } = {}) {
  const params = [];
  let dateClause = '';
  if (from) {
    dateClause += ' AND datetime(commence_time) >= datetime(?)';
    params.push(from);
  }
  if (to) {
    dateClause += ' AND datetime(commence_time) <= datetime(?)';
    params.push(to);
  }
  return db.prepare(`
    SELECT id, commence_time, official_date, home_team, away_team, home_score, away_score
    FROM games
    WHERE league = 'MLB'
      AND completed = 1
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND NOT (home_score = 0 AND away_score = 0)
      AND home_team NOT IN ('American League', 'National League')
      AND away_team NOT IN ('American League', 'National League')
      ${dateClause}
    ORDER BY datetime(commence_time) ASC, id ASC
  `).all(...params).filter((game) =>
    isMlbRegularSeasonTeam(game.home_team) && isMlbRegularSeasonTeam(game.away_team)
  );
}

/**
 * 產生指定期間的每場賽前隊級特徵。
 * stateSeedFrom 以前的比賽只負責建立狀態，不輸出資料列。
 */
export function buildMlbHistoricalFeatureRows({ from, to } = {}) {
  const allGames = completedMlbGames({ to });
  const states = new Map();
  const output = [];
  const outputFrom = from ? Date.parse(from) : -Infinity;

  for (const game of allGames) {
    const season = String(game.commence_time).slice(0, 4);
    const homeKey = `${season}:${game.home_team}`;
    const awayKey = `${season}:${game.away_team}`;
    const home = states.get(homeKey) || emptyTeam();
    const away = states.get(awayKey) || emptyTeam();
    const commenceMs = Date.parse(game.commence_time);
    const homeScore = finite(game.home_score, NaN);
    const awayScore = finite(game.away_score, NaN);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore === awayScore) continue;

    if (commenceMs >= outputFrom) {
      const homeFeature = teamFeature(home, game.commence_time);
      const awayFeature = teamFeature(away, game.commence_time);
      output.push({
        gameId: game.id,
        commenceTime: game.commence_time,
        officialDate: game.official_date,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        features: {
          home: homeFeature,
          away: awayFeature,
          vector: buildMlbTeamFeatureVector(homeFeature, awayFeature),
        },
        homeWin: homeScore > awayScore ? 1 : 0,
      });
    }

    updateTeam(home, {
      isHome: true,
      won: homeScore > awayScore,
      runsFor: homeScore,
      runsAgainst: awayScore,
      commenceTime: game.commence_time,
    });
    updateTeam(away, {
      isHome: false,
      won: awayScore > homeScore,
      runsFor: awayScore,
      runsAgainst: homeScore,
      commenceTime: game.commence_time,
    });
    states.set(homeKey, home);
    states.set(awayKey, away);
  }
  return output;
}

/**
 * 即時推論使用與歷史訓練完全相同的本機 PIT 隊級狀態。
 * 官方 API 證據仍獨立展示，但不能混成另一套模型特徵定義。
 */
export function buildMlbTeamFeatureStateAt(homeTeam, awayTeam, commenceTime) {
  const games = completedMlbGames({ to: commenceTime });
  const season = String(commenceTime).slice(0, 4);
  const states = new Map();
  for (const game of games) {
    if (String(game.commence_time).slice(0, 4) !== season) continue;
    if (Date.parse(game.commence_time) >= Date.parse(commenceTime)) continue;
    const home = states.get(game.home_team) || emptyTeam();
    const away = states.get(game.away_team) || emptyTeam();
    const homeScore = finite(game.home_score, NaN);
    const awayScore = finite(game.away_score, NaN);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore === awayScore) continue;
    updateTeam(home, {
      isHome: true,
      won: homeScore > awayScore,
      runsFor: homeScore,
      runsAgainst: awayScore,
      commenceTime: game.commence_time,
    });
    updateTeam(away, {
      isHome: false,
      won: awayScore > homeScore,
      runsFor: awayScore,
      runsAgainst: homeScore,
      commenceTime: game.commence_time,
    });
    states.set(game.home_team, home);
    states.set(game.away_team, away);
  }
  const home = teamFeature(states.get(homeTeam) || emptyTeam(), commenceTime);
  const away = teamFeature(states.get(awayTeam) || emptyTeam(), commenceTime);
  return {
    source: 'local completed-game PIT ledger',
    home,
    away,
    vector: buildMlbTeamFeatureVector(home, away),
  };
}

async function mapWithConcurrency(entries, concurrency, mapper) {
  const results = new Array(entries.length);
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(entries[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return results;
}

/**
 * 使用賽後 boxscore 僅辨識「實際先發投手」；投手能力仍以該場前一天截止。
 * historical boxscore 沒有可靠的賽前發布時間，因此 source 必須保留這個限制。
 */
export async function enrichRowsWithHistoricalPitchers(rows, { concurrency = 6 } = {}) {
  const scheduleByCommenceDay = new Map();
  const resolveOfficialGame = async (row) => {
    if (String(row.gameId).startsWith('mlb-official-')) {
      return {
        gamePk: Number(String(row.gameId).slice('mlb-official-'.length)),
        officialDate: row.officialDate ?? row.commenceTime.slice(0, 10),
      };
    }
    const date = row.commenceTime.slice(0, 10);
    if (!scheduleByCommenceDay.has(date)) {
      scheduleByCommenceDay.set(date, getMlbScheduleAround(row.commenceTime));
    }
    const schedule = await scheduleByCommenceDay.get(date);
    return matchMlbOfficialGame(row, schedule);
  };
  const contexts = await mapWithConcurrency(rows, concurrency, async (row) => {
    const official = await resolveOfficialGame(row);
    const boxscore = await getMlbGameBoxscore(official?.gamePk);
    return { row, official, boxscore };
  });

  const bullpenHistory = new Map();
  const battingHistory = new Map();
  for (const context of contexts) {
    const { row, boxscore } = context;
    const homeHistory = bullpenHistory.get(row.homeTeam) || [];
    const awayHistory = bullpenHistory.get(row.awayTeam) || [];
    const homeBattingHistory = battingHistory.get(row.homeTeam) || [];
    const awayBattingHistory = battingHistory.get(row.awayTeam) || [];
    const homeBullpen = bullpenHistorySummary(homeHistory);
    const awayBullpen = bullpenHistorySummary(awayHistory);
    const bullpenVector = buildBullpenWorkloadVector(homeBullpen, awayBullpen);
    const recentBoxscore = {
      home: {
        batting: recentBattingSummary(homeBattingHistory),
        bullpen: bullpenQualitySummary(homeHistory),
      },
      away: {
        batting: recentBattingSummary(awayBattingHistory),
        bullpen: bullpenQualitySummary(awayHistory),
      },
    };
    const recentBoxscoreVector = buildRecentBoxscoreVector(
      recentBoxscore.home,
      recentBoxscore.away
    );
    context.row = {
      ...row,
      features: {
        ...row.features,
        bullpen: {
          source: 'MLB Stats API prior final boxscores; strict pregame last-3 games',
          home: homeBullpen,
          away: awayBullpen,
        },
        recentBoxscore: {
          source: 'MLB Stats API prior final boxscores; batting last-14 and bullpen last-7',
          ...recentBoxscore,
        },
        vector: {
          ...row.features.vector,
          ...(bullpenVector || {}),
          ...(recentBoxscoreVector || {}),
        },
      },
      bullpenFeaturesComplete: Boolean(bullpenVector),
      recentBoxscoreFeaturesComplete: Boolean(recentBoxscoreVector),
    };
    const currentHomeUsage = bullpenUsageFromBoxscore(boxscore, 'home');
    const currentAwayUsage = bullpenUsageFromBoxscore(boxscore, 'away');
    const currentHomeBatting = battingUsageFromBoxscore(boxscore, 'home');
    const currentAwayBatting = battingUsageFromBoxscore(boxscore, 'away');
    if (currentHomeUsage) {
      homeHistory.push(currentHomeUsage);
      bullpenHistory.set(row.homeTeam, homeHistory);
    }
    if (currentAwayUsage) {
      awayHistory.push(currentAwayUsage);
      bullpenHistory.set(row.awayTeam, awayHistory);
    }
    if (currentHomeBatting) {
      homeBattingHistory.push(currentHomeBatting);
      battingHistory.set(row.homeTeam, homeBattingHistory);
    }
    if (currentAwayBatting) {
      awayBattingHistory.push(currentAwayBatting);
      battingHistory.set(row.awayTeam, awayBattingHistory);
    }
  }

  return mapWithConcurrency(contexts, concurrency, async ({ row, official, boxscore }) => {
    const probableSnapshot = resolveMlbProbableStarterSnapshot(
      row.gameId,
      row.commenceTime
    );
    const usesPitProbable =
      probableSnapshot.ok && probableSnapshot.status === 'complete';
    const homePitcherId = usesPitProbable
      ? probableSnapshot.home.id
      : boxscore?.teams?.home?.pitchers?.[0] ?? null;
    const awayPitcherId = usesPitProbable
      ? probableSnapshot.away.id
      : boxscore?.teams?.away?.pitchers?.[0] ?? null;
    const pitOptions = {
      cutoffDate: official?.officialDate ?? null,
      excludeGamePk: official?.gamePk ?? null,
    };
    const [homePitcher, awayPitcher, homeRecent, awayRecent] = await Promise.all([
      getMlbPitcherPregameFeaturesFromGameLog(homePitcherId, row.commenceTime, pitOptions),
      getMlbPitcherPregameFeaturesFromGameLog(awayPitcherId, row.commenceTime, pitOptions),
      getMlbPitcherRecentStartFeatures(homePitcherId, row.commenceTime, pitOptions),
      getMlbPitcherRecentStartFeatures(awayPitcherId, row.commenceTime, pitOptions),
    ]);
    const seasonVector = pitcherVector(homePitcher, awayPitcher);
    const recentVector = recentPitcherVector(homeRecent, awayRecent);
    return {
      ...row,
      features: {
        ...row.features,
        pitchers: {
          source: usesPitProbable
            ? 'MLB Stats API schedule probable starter snapshot; strict pregame identity'
            : 'MLB Stats API postmatch boxscore actual starter; oracle identity only',
          identityMode: usesPitProbable
            ? 'pit_probable'
            : 'postgame_actual_oracle',
          identitySnapshotId: usesPitProbable
            ? probableSnapshot.snapshotId
            : null,
          homeIdentity: {
            id: homePitcherId,
            name: usesPitProbable ? probableSnapshot.home.name : null,
          },
          awayIdentity: {
            id: awayPitcherId,
            name: usesPitProbable ? probableSnapshot.away.name : null,
          },
          home: homePitcher,
          away: awayPitcher,
          homeRecent,
          awayRecent,
        },
        vector: seasonVector
          ? {
              ...row.features.vector,
              ...seasonVector,
              ...(recentVector || {}),
            }
          : row.features.vector,
      },
      pitcherFeaturesComplete: Boolean(seasonVector),
      recentPitcherFeaturesComplete: Boolean(seasonVector && recentVector),
    };
  });
}

export function persistMlbHistoricalFeatureRows(rows, { replaceVersion = false } = {}) {
  const upsert = db.prepare(`
    INSERT INTO mlb_historical_feature_rows
      (game_id, commence_time, feature_version, features_json, home_win)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET
      commence_time = excluded.commence_time,
      feature_version = excluded.feature_version,
      features_json = excluded.features_json,
      home_win = excluded.home_win,
      created_at = datetime('now')
  `);
  db.transaction(() => {
    if (replaceVersion) {
      db.prepare(`
        DELETE FROM mlb_historical_feature_rows
        WHERE feature_version = ?
      `).run(MLB_BASELINE_FEATURE_VERSION);
    }
    for (const row of rows) {
      upsert.run(
        row.gameId,
        row.commenceTime,
        MLB_BASELINE_FEATURE_VERSION,
        JSON.stringify(row.features),
        row.homeWin
      );
    }
  })();
  return rows.length;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
}

function metrics(rows, model) {
  if (!rows.length) return { samples: 0, brier: null, logLoss: null, accuracy: null };
  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  for (const row of rows) {
    const probability = predictMlbBaseline(model, row.features.vector);
    brier += (probability - row.homeWin) ** 2;
    logLoss += -(row.homeWin * Math.log(probability) + (1 - row.homeWin) * Math.log(1 - probability));
    if ((probability >= 0.5 ? 1 : 0) === row.homeWin) correct += 1;
  }
  return {
    samples: rows.length,
    brier: brier / rows.length,
    logLoss: logLoss / rows.length,
    accuracy: correct / rows.length,
  };
}

/**
 * 不依賴外部套件的正則化 logistic baseline。
 * 依時間切成 60% train／20% validation／20% final test；
 * validation 可選特徵，final test 僅能報告一次，禁止用來挑模型。
 */
function trainLogistic(rows, { featureKeys, epochs, learningRate, l2 }) {
  const means = {};
  const scales = {};
  for (const key of featureKeys) {
    means[key] = rows.reduce((sum, row) => sum + finite(row.features.vector[key]), 0) / rows.length;
    const variance = rows.reduce(
      (sum, row) => sum + (finite(row.features.vector[key]) - means[key]) ** 2,
      0
    ) / rows.length;
    scales[key] = Math.max(0.01, Math.sqrt(variance));
  }
  const weights = Object.fromEntries(featureKeys.map((key) => [key, 0]));
  let intercept = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let interceptGradient = 0;
    const gradients = Object.fromEntries(featureKeys.map((key) => [key, 0]));
    for (const row of rows) {
      const z = intercept + featureKeys.reduce(
        (sum, key) => sum + weights[key] * ((finite(row.features.vector[key]) - means[key]) / scales[key]),
        0
      );
      const error = sigmoid(z) - row.homeWin;
      interceptGradient += error;
      for (const key of featureKeys) {
        gradients[key] += error * ((finite(row.features.vector[key]) - means[key]) / scales[key]);
      }
    }
    intercept -= learningRate * interceptGradient / rows.length;
    for (const key of featureKeys) {
      weights[key] -= learningRate * (gradients[key] / rows.length + l2 * weights[key]);
    }
  }
  return {
    featureVersion: MLB_BASELINE_FEATURE_VERSION,
    featureKeys,
    means,
    scales,
    weights,
    intercept,
  };
}

export function fitMlbBaseline(
  rows,
  {
    featureKeys = FEATURE_KEYS,
    epochs = 900,
    learningRate = 0.08,
    l2 = 0.02,
    /** walk-forward 時用全部先前資料訓練，不再切 holdout */
    holdout = true,
  } = {}
) {
  if (rows.length < 60) throw new Error('historical_rows_insufficient');
  if (!holdout) {
    const model = trainLogistic(rows, { featureKeys, epochs, learningRate, l2 });
    return {
      model,
      train: rows,
      validation: [],
      test: [],
      metrics: {
        train: metrics(rows, model),
        validation: metrics([], model),
        test: metrics([], model),
      },
    };
  }
  const trainEnd = Math.max(36, Math.floor(rows.length * 0.6));
  const validationEnd = Math.max(trainEnd + 12, Math.floor(rows.length * 0.8));
  const train = rows.slice(0, trainEnd);
  const validation = rows.slice(trainEnd, validationEnd);
  const test = rows.slice(validationEnd);
  const model = trainLogistic(train, { featureKeys, epochs, learningRate, l2 });
  return {
    model,
    train,
    validation,
    test,
    metrics: {
      train: metrics(train, model),
      validation: metrics(validation, model),
      test: metrics(test, model),
    },
  };
}

export function predictMlbBaseline(model, vector) {
  const z = finite(model?.intercept);
  const score = (model?.featureKeys || FEATURE_KEYS).reduce((sum, key) => {
    const value = (finite(vector?.[key]) - finite(model?.means?.[key])) /
      Math.max(0.01, finite(model?.scales?.[key], 1));
    return sum + finite(model?.weights?.[key]) * value;
  }, z);
  return Math.max(0.001, Math.min(0.999, sigmoid(score)));
}

export function composeMlbFeatureVector(
  teamVector,
  homePitcher = null,
  awayPitcher = null,
  homeRecentPitcher = null,
  awayRecentPitcher = null,
  homeBullpen = null,
  awayBullpen = null
) {
  if (!teamVector || !Object.values(teamVector).every(Number.isFinite)) return null;
  const pitchers = pitcherVector(homePitcher, awayPitcher);
  const recentPitchers = recentPitcherVector(homeRecentPitcher, awayRecentPitcher);
  const bullpen = buildBullpenWorkloadVector(homeBullpen, awayBullpen);
  return {
    ...teamVector,
    ...(bullpen || {}),
    ...(pitchers || {}),
    ...(recentPitchers || {}),
  };
}

export async function rebuildMlbBaseline({ from, to, includePitchers = true } = {}) {
  let rows = buildMlbHistoricalFeatureRows({ from, to });
  if (includePitchers) rows = await enrichRowsWithHistoricalPitchers(rows);
  persistMlbHistoricalFeatureRows(rows, { replaceVersion: !from });
  const teamFit = fitMlbBaseline(rows, { featureKeys: FEATURE_KEYS });
  const bullpenRows = includePitchers ? rows.filter((row) => row.bullpenFeaturesComplete) : [];
  const bullpenCohortTeamFit = bullpenRows.length >= 40
    ? fitMlbBaseline(bullpenRows, { featureKeys: FEATURE_KEYS })
    : null;
  const bullpenFit = bullpenRows.length >= 40
    ? fitMlbBaseline(bullpenRows, {
        featureKeys: [...FEATURE_KEYS, ...BULLPEN_FEATURE_KEYS],
      })
    : null;
  const pitcherRows = includePitchers ? rows.filter((row) => row.pitcherFeaturesComplete) : [];
  const pitcherCohortTeamFit = pitcherRows.length >= 40
    ? fitMlbBaseline(pitcherRows, { featureKeys: FEATURE_KEYS })
    : null;
  const pitcherFit = pitcherRows.length >= 40
    ? fitMlbBaseline(pitcherRows, { featureKeys: [...FEATURE_KEYS, ...PITCHER_FEATURE_KEYS] })
    : null;
  const recentPitcherRows = includePitchers
    ? rows.filter((row) => row.recentPitcherFeaturesComplete)
    : [];
  const recentPitcherCohortTeamFit = recentPitcherRows.length >= 40
    ? fitMlbBaseline(recentPitcherRows, { featureKeys: FEATURE_KEYS })
    : null;
  const recentPitcherFit = recentPitcherRows.length >= 40
    ? fitMlbBaseline(recentPitcherRows, {
        featureKeys: [...FEATURE_KEYS, ...PITCHER_FEATURE_KEYS, ...RECENT_PITCHER_FEATURE_KEYS],
      })
    : null;
  const foundationRows = rows.filter((row) =>
    MLB_FOUNDATION_FEATURE_KEYS.every((key) =>
      Number.isFinite(row.features?.vector?.[key])
    )
  );
  const foundationFit = foundationRows.length >= 40
    ? fitMlbBaseline(foundationRows, { featureKeys: MLB_FOUNDATION_FEATURE_KEYS })
    : null;
  const materiallyImproves = (candidate, baseline) => {
    if (!candidate || !baseline) return false;
    const next = candidate.metrics.validation;
    const base = baseline.metrics.validation;
    return next.brier <= base.brier - 0.001 &&
      next.logLoss <= base.logLoss - 0.002 &&
      next.accuracy >= base.accuracy;
  };
  const bullpenImproves = materiallyImproves(bullpenFit, bullpenCohortTeamFit);
  const recentImproves = materiallyImproves(recentPitcherFit, recentPitcherCohortTeamFit);
  const seasonImproves = materiallyImproves(pitcherFit, pitcherCohortTeamFit);
  // 歷史投手身份來自賽後實際先發，live 只有 probable；身份口徑統一前不得部署。
  const pitcherVariantsDeployable = false;
  const selected = pitcherVariantsDeployable && recentImproves
    ? { key: 'team_plus_recent_pitcher', fit: recentPitcherFit }
    : pitcherVariantsDeployable && seasonImproves
      ? { key: 'team_plus_season_pitcher', fit: pitcherFit }
      : bullpenImproves
        ? { key: 'team_plus_bullpen', fit: bullpenFit }
        : { key: 'team_only', fit: teamFit };
  const selectedFit = selected.fit;
  // 評估段只負責選模；部署／serve 權重必須用截至 training_to 的全部可用資料重訓，
  // 才能與 expanding walk-forward 的 regime 一致。
  const deploymentRows = selected.key === 'team_plus_recent_pitcher'
    ? recentPitcherRows
    : selected.key === 'team_plus_season_pitcher'
      ? pitcherRows
      : selected.key === 'team_plus_bullpen'
        ? bullpenRows
        : rows;
  const deploymentFit = fitMlbBaseline(deploymentRows, {
    featureKeys: selectedFit.model.featureKeys,
    holdout: false,
  });
  const challengerModel = (cohort, featureKeys) =>
    cohort.length >= 40
      ? fitMlbBaseline(cohort, { featureKeys, holdout: false }).model
      : null;
  const metrics = {
    teamOnly: teamFit.metrics,
    teamOnlyOnBullpenCohort: bullpenCohortTeamFit?.metrics ?? null,
    teamPlusBullpen: bullpenFit?.metrics ?? null,
    bullpenImproves,
    teamOnlyOnSeasonPitcherCohort: pitcherCohortTeamFit?.metrics ?? null,
    teamPlusSeasonPitcher: pitcherFit?.metrics ?? null,
    teamOnlyOnRecentPitcherCohort: recentPitcherCohortTeamFit?.metrics ?? null,
    teamPlusRecentPitcher: recentPitcherFit?.metrics ?? null,
    foundation: foundationFit?.metrics ?? null,
    selectedVariant: selected.key,
    pitcherVariantsDeployable,
    pitcherDeploymentBlockReason:
      'historical_actual_starter_identity_differs_from_live_probable_pitcher',
    pitcherCoverage: {
      rows: pitcherRows.length,
      total: rows.length,
      ratio: rows.length ? pitcherRows.length / rows.length : 0,
      actualStarterIdentity:
        '歷史 boxscore 僅用來辨識實際先發；投手統計採開賽前日期截止。',
    },
    recentPitcherCoverage: {
      rows: recentPitcherRows.length,
      total: rows.length,
      ratio: rows.length ? recentPitcherRows.length / rows.length : 0,
    },
    foundationCoverage: {
      rows: foundationRows.length,
      total: rows.length,
      ratio: rows.length ? foundationRows.length / rows.length : 0,
      featureKeys: MLB_FOUNDATION_FEATURE_KEYS,
    },
    bullpenCoverage: {
      rows: bullpenRows.length,
      total: rows.length,
      ratio: rows.length ? bullpenRows.length / rows.length : 0,
      contract: '雙方開賽前最近 3 場官方 final boxscore 後援用球數與登板人次',
    },
    researchChallengers: {
      teamPlusBullpen: {
        deployable: bullpenImproves,
        blockReason: bullpenImproves ? null : 'selection_metrics_not_improved',
        model: challengerModel(bullpenRows, [...FEATURE_KEYS, ...BULLPEN_FEATURE_KEYS]),
      },
      teamPlusSeasonPitcher: {
        deployable: false,
        blockReason: 'requires_forward_probable_pitcher_validation',
        model: challengerModel(pitcherRows, [...FEATURE_KEYS, ...PITCHER_FEATURE_KEYS]),
      },
      teamPlusRecentPitcher: {
        deployable: false,
        blockReason: 'requires_forward_probable_pitcher_validation',
        model: challengerModel(recentPitcherRows, [
          ...FEATURE_KEYS,
          ...PITCHER_FEATURE_KEYS,
          ...RECENT_PITCHER_FEATURE_KEYS,
        ]),
      },
      foundation: {
        deployable: false,
        blockReason: 'cross_season_validation_required',
        model: challengerModel(foundationRows, MLB_FOUNDATION_FEATURE_KEYS),
      },
    },
  };
  db.prepare(`
    INSERT INTO mlb_baseline_models
      (feature_version, training_from, training_to, train_samples, test_samples, metrics_json, model_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    MLB_BASELINE_FEATURE_VERSION,
    rows[0]?.commenceTime ?? from ?? '',
    rows.at(-1)?.commenceTime ?? to ?? '',
    deploymentFit.train.length,
    selectedFit.test.length,
    JSON.stringify(metrics),
    JSON.stringify(deploymentFit.model)
  );
  return {
    rows: rows.length,
    bullpenRows: bullpenRows.length,
    pitcherRows: pitcherRows.length,
    recentPitcherRows: recentPitcherRows.length,
    foundationRows: foundationRows.length,
    from: rows[0]?.commenceTime ?? null,
    to: rows.at(-1)?.commenceTime ?? null,
    metrics,
    model: deploymentFit.model,
  };
}

export function getLatestMlbBaselineModel() {
  const row = db.prepare(`
    SELECT feature_version, metrics_json, model_json, created_at
    FROM mlb_baseline_models
    WHERE feature_version = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(MLB_BASELINE_FEATURE_VERSION);
  if (!row) return null;
  return {
    featureVersion: row.feature_version,
    metrics: JSON.parse(row.metrics_json),
    model: JSON.parse(row.model_json),
    createdAt: row.created_at,
  };
}

export function liveVectorFromOfficialHistory(
  home,
  away,
  homePitcher = null,
  awayPitcher = null,
  homeRecentPitcher = null,
  awayRecentPitcher = null,
  homeBullpen = null,
  awayBullpen = null
) {
  if (!home || !away) return null;
  const recordPct = (record, prefix = '') => {
    const winsKey = prefix ? `${prefix}Wins` : 'wins';
    const lossesKey = prefix ? `${prefix}Losses` : 'losses';
    return winPct(finite(record?.[winsKey]), finite(record?.[lossesKey]));
  };
  const team = {
    seasonWinPct: recordPct(home.record),
    homeWinPct: recordPct(home.record, 'home'),
    awayWinPct: recordPct(home.record, 'away'),
    last10WinPct: recordPct(home.record, 'last10'),
    recentRunsPerGame: finite(home.offense?.runsPerGame),
    recentRunsAllowedPerGame: finite(home.pitching?.runsAllowedPerGame),
  };
  const awayTeam = {
    seasonWinPct: recordPct(away.record),
    homeWinPct: recordPct(away.record, 'home'),
    awayWinPct: recordPct(away.record, 'away'),
    last10WinPct: recordPct(away.record, 'last10'),
    recentRunsPerGame: finite(away.offense?.runsPerGame),
    recentRunsAllowedPerGame: finite(away.pitching?.runsAllowedPerGame),
  };
  const teamVector = buildMlbTeamFeatureVector(team, awayTeam);
  return composeMlbFeatureVector(
    teamVector,
    homePitcher,
    awayPitcher,
    homeRecentPitcher,
    awayRecentPitcher,
    homeBullpen,
    awayBullpen
  );
}
