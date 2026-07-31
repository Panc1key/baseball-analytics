/**
 * 分析極端比分場：爆分 vs 低分，對照先發/牛棚出局與失分。
 */
import db from '../src/db/database.js';
import {
  getMlbGameBoxscore,
  getMlbScheduleAround,
  matchMlbOfficialGame,
} from '../src/services/MlbStatsService.js';

const TARGETS = [
  { label: '爆分-Nats23', dateHint: '2026-07-18', away: 'Washington', home: 'Athletics', actual: '23-4' },
  { label: '爆分-CWS12', dateHint: '2026-07-17', away: 'White Sox', home: 'Blue Jays', actual: '12-4' },
  { label: '爆分-BOS10', dateHint: '2026-07-17', away: 'Rays', home: 'Red Sox', actual: '0-10' },
  { label: '低分-TOR1', dateHint: '2026-07-18', away: 'White Sox', home: 'Blue Jays', actual: '0-1' },
  { label: '低分-NYY2', dateHint: '2026-07-19', away: 'Dodgers', home: 'Yankees', actual: '1-2' },
  { label: '低分-MIL0', dateHint: '2026-07-21', away: 'Mets', home: 'Brewers', actual: '4-0' },
  { label: '低分-SF3', dateHint: '2026-07-12', away: 'Rockies', home: 'Giants', actual: '1-3' },
  { label: '一邊完封-LAA0', dateHint: '2026-07-19', away: 'Tigers', home: 'Angels', actual: '7-0' },
];

function parseIp(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  const n = Number(s.replace(/(\d+)\.1$/, '$1.333').replace(/(\d+)\.2$/, '$1.666'));
  return Number.isFinite(n) ? n : null;
}

function sidePitching(box, side) {
  const team = box?.teams?.[side];
  if (!team) return null;
  const pitchers = (team.pitchers || []).map((id) => {
    const player = team.players?.[`ID${id}`];
    const p = player?.stats?.pitching || {};
    return {
      id,
      name: player?.person?.fullName || String(id),
      ip: parseIp(p.inningsPitched),
      ipRaw: p.inningsPitched ?? null,
      er: p.earnedRuns != null ? Number(p.earnedRuns) : null,
      r: p.runs != null ? Number(p.runs) : null,
      h: p.hits != null ? Number(p.hits) : null,
      bb: p.baseOnBalls != null ? Number(p.baseOnBalls) : null,
      k: p.strikeOuts != null ? Number(p.strikeOuts) : null,
      hr: p.homeRuns != null ? Number(p.homeRuns) : null,
      pitches: p.numberOfPitches != null ? Number(p.numberOfPitches) : null,
      note: p.note || null,
    };
  });
  const starter = pitchers[0] || null;
  const bullpen = pitchers.slice(1);
  const bullpenER = bullpen.reduce((s, p) => s + (p.er || 0), 0);
  const bullpenR = bullpen.reduce((s, p) => s + (p.r || 0), 0);
  const bullpenIP = bullpen.reduce((s, p) => s + (p.ip || 0), 0);
  return {
    teamName: team.team?.name || side,
    runs: team.teamStats?.batting?.runs ?? null,
    hits: team.teamStats?.batting?.hits ?? null,
    starter,
    bullpen,
    bullpenER,
    bullpenR,
    bullpenIP: Number(bullpenIP.toFixed(3)),
    pitcherCount: pitchers.length,
  };
}

function topBatters(box, side, limit = 5) {
  const team = box?.teams?.[side];
  if (!team) return [];
  const batters = (team.batters || []).map((id) => {
    const player = team.players?.[`ID${id}`];
    const b = player?.stats?.batting || {};
    return {
      name: player?.person?.fullName || String(id),
      ab: b.atBats != null ? Number(b.atBats) : 0,
      h: b.hits != null ? Number(b.hits) : 0,
      r: b.runs != null ? Number(b.runs) : 0,
      rbi: b.rbi != null ? Number(b.rbi) : 0,
      hr: b.homeRuns != null ? Number(b.homeRuns) : 0,
    };
  }).filter((b) => b.ab > 0 || b.h > 0 || b.hr > 0);
  return batters
    .sort((a, b) => (b.rbi - a.rbi) || (b.h - a.h) || (b.hr - a.hr))
    .slice(0, limit);
}

async function resolveGame(target) {
  // Prefer local DB match first
  const local = db.prepare(`
    SELECT id, home_team, away_team, home_score, away_score, commence_time, completed
    FROM games
    WHERE completed = 1
      AND date(commence_time) = date(?)
      AND home_team LIKE ?
      AND away_team LIKE ?
    LIMIT 1
  `).get(
    target.dateHint,
    `%${target.home.split(' ').pop()}%`,
    `%${target.away.split(' ').pop()}%`
  );

  let commence = local?.commence_time || `${target.dateHint}T20:00:00Z`;
  let homeTeam = local?.home_team;
  let awayTeam = local?.away_team;
  let homeScore = local?.home_score;
  let awayScore = local?.away_score;

  const snap = local
    ? db.prepare(`
        SELECT official_game_pk, home_pitcher_name, away_pitcher_name
        FROM mlb_probable_starter_snapshots
        WHERE game_id = ? AND status = 'complete'
        ORDER BY datetime(captured_at) DESC
        LIMIT 1
      `).get(local.id)
    : null;

  let gamePk = snap?.official_game_pk ? Number(snap.official_game_pk) : null;
  if (!gamePk) {
    const schedule = await getMlbScheduleAround(commence);
    const official = matchMlbOfficialGame({
      commence_time: commence,
      home_team: homeTeam || target.home,
      away_team: awayTeam || target.away,
    }, schedule);
    gamePk = official?.gamePk ?? null;
    if (!homeTeam && official) {
      homeTeam = official.homeName;
      awayTeam = official.awayName;
    }
  }

  if (!gamePk) {
    return { ok: false, label: target.label, error: 'gamePk_not_found', local };
  }

  const box = await getMlbGameBoxscore(gamePk);
  const home = sidePitching(box, 'home');
  const away = sidePitching(box, 'away');

  // 對失分方：主隊失分 = 客隊得分
  const homeAllowed = {
    byStarter: away?.starter ? null : null,
  };

  // 誰被打爆：看失分方投手線
  // 客隊得很多分 → 主隊投手崩；主隊得很多分 → 客隊投手崩
  const homeRuns = Number(homeScore ?? home?.runs);
  const awayRuns = Number(awayScore ?? away?.runs);

  function collapseSide(pitchingSide, runsAllowed) {
    if (!pitchingSide) return null;
    const starterER = pitchingSide.starter?.er ?? 0;
    const starterIP = pitchingSide.starter?.ip ?? 0;
    const earlyExit = starterIP != null && starterIP < 4.0;
    const starterBlown = starterER >= 5 || (earlyExit && starterER >= 3);
    const bullpenBlown = pitchingSide.bullpenER >= 4 || pitchingSide.pitcherCount >= 5;
    return {
      team: pitchingSide.teamName,
      runsAllowed,
      starter: pitchingSide.starter,
      bullpenSummary: {
        count: Math.max(0, pitchingSide.pitcherCount - 1),
        ip: pitchingSide.bullpenIP,
        er: pitchingSide.bullpenER,
        r: pitchingSide.bullpenR,
      },
      earlyExit,
      starterBlown,
      bullpenBlown,
      interpretation: starterBlown && bullpenBlown
        ? '先發崩 + 牛棚也崩'
        : starterBlown
          ? '先發崩盤（短局數高失分）'
          : bullpenBlown
            ? '牛棚崩盤／多人失分'
            : '投手線未見極端崩，可能是打線全面開花或累積',
    };
  }

  return {
    ok: true,
    label: target.label,
    actualHint: target.actual,
    gamePk,
    commenceTime: commence,
    matchup: `${awayTeam || target.away} @ ${homeTeam || target.home}`,
    score: `${awayRuns}-${homeRuns}`,
    total: awayRuns + homeRuns,
    awayOffenseTop: topBatters(box, 'away'),
    homeOffenseTop: topBatters(box, 'home'),
    // 客隊得分高 → 主隊投手被打
    homePitchingAllowedAwayRuns: collapseSide(home, awayRuns),
    // 主隊得分高 → 客隊投手被打
    awayPitchingAllowedHomeRuns: collapseSide(away, homeRuns),
    awayStarterNamed: snap?.away_pitcher_name || away?.starter?.name,
    homeStarterNamed: snap?.home_pitcher_name || home?.starter?.name,
  };
}

const results = [];
for (const target of TARGETS) {
  try {
    results.push(await resolveGame(target));
  } catch (error) {
    results.push({ ok: false, label: target.label, error: String(error?.message || error) });
  }
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
