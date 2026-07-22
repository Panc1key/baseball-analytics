import db from '../db/database.js';
import { getMlbScheduleDateRange } from './MlbStatsService.js';

export function officialScheduleGameRow(game) {
  const homeScore = Number(game?.teams?.home?.score);
  const awayScore = Number(game?.teams?.away?.score);
  const homeTeam = game?.teams?.home?.team?.name;
  const awayTeam = game?.teams?.away?.team?.name;
  const final = game?.status?.abstractGameState === 'Final';
  if (
    game?.gameType !== 'R' ||
    !final ||
    !game?.gamePk ||
    !game?.gameDate ||
    !homeTeam ||
    !awayTeam ||
    !Number.isFinite(homeScore) ||
    !Number.isFinite(awayScore) ||
    homeScore === awayScore
  ) {
    return null;
  }
  return {
    id: `mlb-official-${game.gamePk}`,
    league: 'MLB',
    commenceTime: game.gameDate,
    officialDate: game.officialDate ?? game.gameDate.slice(0, 10),
    homeTeam,
    awayTeam,
    homeScore,
    awayScore,
    status: 'completed',
  };
}

export async function backfillMlbOfficialHistory({ startDate, endDate }) {
  const schedule = await getMlbScheduleDateRange(startDate, endDate);
  const rows = schedule.map(officialScheduleGameRow).filter(Boolean);
  const upsert = db.prepare(`
    INSERT INTO games
      (id, league, commence_time, home_team, away_team, completed,
       home_score, away_score, official_date, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      commence_time = excluded.commence_time,
      home_team = excluded.home_team,
      away_team = excluded.away_team,
      completed = 1,
      home_score = excluded.home_score,
      away_score = excluded.away_score,
      official_date = excluded.official_date,
      status = excluded.status,
      updated_at = datetime('now')
  `);
  const result = db.transaction((entries) => {
    for (const row of entries) {
      upsert.run(
        row.id,
        row.league,
        row.commenceTime,
        row.homeTeam,
        row.awayTeam,
        row.homeScore,
        row.awayScore,
        row.officialDate,
        row.status
      );
    }
    return entries.length;
  })(rows);
  return {
    startDate,
    endDate,
    scheduleGames: schedule.length,
    importedGames: result,
  };
}
