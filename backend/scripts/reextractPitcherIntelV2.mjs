/**
 * 用既有快取材料，以 v2 risk_timing 契約重抽取，再對照完賽結果。
 * 不重新抓新聞，節省檢索；只重跑 DeepSeek。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { config } from '../src/config.js';
import {
  extractPitcherInjuryFlags,
  isActivePitcherRisk,
  isDeepseekConfigured,
} from '../src/services/PitcherInjuryIntelService.js';
import {
  getMlbGameBoxscore,
  getMlbScheduleAround,
  matchMlbOfficialGame,
} from '../src/services/MlbStatsService.js';

if (!isDeepseekConfigured()) {
  console.error(JSON.stringify({ ok: false, error: 'deepseek_api_key_missing' }));
  process.exit(1);
}

const cacheRows = db.prepare(`
  SELECT cache_key, game_id, pitcher_id, pitcher_name, league, commence_time,
         materials_json, flags_json, status
  FROM mlb_pitcher_injury_intel_cache
  WHERE status IN ('ok', 'partial')
    AND materials_json IS NOT NULL
  ORDER BY datetime(fetched_at) DESC
`).all();

// dedupe by game+pitcher, prefer non-trial keys last overwrite
const byKey = new Map();
for (const row of cacheRows) {
  const gameId = String(row.game_id || '').replace(/:trial10$/, '');
  const key = `${gameId}::${row.pitcher_name}`;
  if (!byKey.has(key)) byKey.set(key, { ...row, gameId });
}
const targets = [...byKey.values()];
console.error(`reextract targets=${targets.length}`);

function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

function bucket(list, pred) {
  const yes = list.filter(pred);
  const no = list.filter((r) => !pred(r));
  const m = (rows, key) => mean(rows.map((r) => r[key]).filter((v) => v != null));
  return {
    nYes: yes.length,
    nNo: no.length,
    winYes: m(yes, 'teamWon'),
    winNo: m(no, 'teamWon'),
    teamRAYes: m(yes, 'teamRunsAllowed'),
    teamRANo: m(no, 'teamRunsAllowed'),
    starterERYes: m(yes, 'starterER'),
    starterERNo: m(no, 'starterER'),
    starterIPYes: m(yes, 'starterIP'),
    starterIPNo: m(no, 'starterIP'),
  };
}

async function resolveGamePk(gameId, commenceTime, homeTeam, awayTeam, officialGamePk) {
  if (officialGamePk) return Number(officialGamePk);
  if (String(gameId).startsWith('mlb-official-')) {
    return Number(String(gameId).slice('mlb-official-'.length));
  }
  const schedule = await getMlbScheduleAround(commenceTime);
  const official = matchMlbOfficialGame({
    commence_time: commenceTime,
    home_team: homeTeam,
    away_team: awayTeam,
  }, schedule);
  return official?.gamePk ?? null;
}

function starterLine(boxscore, pitcherId) {
  if (!boxscore || !pitcherId) return null;
  for (const side of ['home', 'away']) {
    const player = boxscore.teams?.[side]?.players?.[`ID${pitcherId}`];
    const pitching = player?.stats?.pitching;
    if (!pitching) continue;
    const raw = String(pitching.inningsPitched || '');
    const innings = raw
      ? Number(raw.replace(/(\d+)\.1$/, '$1.333').replace(/(\d+)\.2$/, '$1.666'))
      : null;
    return {
      side,
      inningsPitched: Number.isFinite(innings) ? innings : null,
      earnedRuns: pitching.earnedRuns != null ? Number(pitching.earnedRuns) : null,
    };
  }
  return null;
}

const results = [];
let i = 0;
for (const row of targets) {
  i += 1;
  let materials = [];
  try { materials = JSON.parse(row.materials_json || '[]'); } catch { materials = []; }
  const extracted = await extractPitcherInjuryFlags({
    pitcherName: row.pitcher_name,
    league: row.league || 'MLB',
    commenceTime: row.commence_time,
    materials,
  });
  if (!extracted.ok) {
    console.error(`fail ${row.pitcher_name}: ${extracted.error}`);
    continue;
  }

  // rewrite cache with v2 flags (same materials)
  db.prepare(`
    UPDATE mlb_pitcher_injury_intel_cache
    SET flags_json = ?, model = ?, fetched_at = datetime('now')
    WHERE cache_key = ?
  `).run(
    JSON.stringify(extracted.result),
    extracted.model || config.deepseekModel,
    row.cache_key
  );

  const game = db.prepare(`
    SELECT id, home_team, away_team, home_score, away_score, completed, commence_time
    FROM games WHERE id = ?
  `).get(row.gameId);

  const snap = db.prepare(`
    SELECT home_pitcher_name, away_pitcher_name, home_pitcher_id, away_pitcher_id, official_game_pk
    FROM mlb_probable_starter_snapshots
    WHERE game_id = ? AND status = 'complete'
    ORDER BY datetime(captured_at) DESC
    LIMIT 1
  `).get(row.gameId);

  let side = null;
  let teamWon = null;
  let teamRunsAllowed = null;
  let starterER = null;
  let starterIP = null;
  if (game?.completed && snap) {
    if (
      snap.home_pitcher_name === row.pitcher_name ||
      snap.home_pitcher_id === row.pitcher_id
    ) {
      side = 'home';
      teamWon = Number(game.home_score) > Number(game.away_score) ? 1 : 0;
      teamRunsAllowed = Number(game.away_score);
    } else if (
      snap.away_pitcher_name === row.pitcher_name ||
      snap.away_pitcher_id === row.pitcher_id
    ) {
      side = 'away';
      teamWon = Number(game.away_score) > Number(game.home_score) ? 1 : 0;
      teamRunsAllowed = Number(game.home_score);
    }
    try {
      const pk = await resolveGamePk(
        row.gameId,
        game.commence_time,
        game.home_team,
        game.away_team,
        snap.official_game_pk
      );
      const box = await getMlbGameBoxscore(pk);
      const pitcherId = row.pitcher_id
        || (side === 'home' ? snap.home_pitcher_id : snap.away_pitcher_id);
      const line = starterLine(box, pitcherId);
      starterER = line?.earnedRuns ?? null;
      starterIP = line?.inningsPitched ?? null;
    } catch { /* ignore */ }
  }

  results.push({
    pitcher: row.pitcher_name,
    gameId: row.gameId,
    commenceTime: row.commence_time,
    completed: Boolean(game?.completed),
    side,
    teamWon,
    teamRunsAllowed,
    starterER,
    starterIP,
    oldInjuryFlag: (() => {
      try { return Boolean(JSON.parse(row.flags_json)?.injury_flag); } catch { return null; }
    })(),
    ...extracted.result,
    active_risk: isActivePitcherRisk(extracted.result),
  });

  if (i % 10 === 0 || i === targets.length) {
    console.error(`progress ${i}/${targets.length}`);
  }
}

const completed = results.filter((r) => r.completed && r.teamWon != null);
const timingCounts = results.reduce((acc, row) => {
  const key = row.risk_timing || 'none';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

const out = {
  ok: true,
  schema: 'v2_risk_timing',
  totalReextracted: results.length,
  timingCounts,
  activeRiskCount: results.filter((r) => r.active_risk).length,
  oldInjuryFlagCount: results.filter((r) => r.oldInjuryFlag).length,
  completed: completed.length,
  outcome: {
    activeRisk: bucket(completed, (r) => r.active_risk),
    pregameActive: bucket(completed, (r) => r.risk_timing === 'pregame_active'),
    recentReturn: bucket(completed, (r) => r.risk_timing === 'recent_return'),
    historicalOnly: bucket(completed, (r) => r.risk_timing === 'historical_only'),
    oldStyleInjuryFlag: bucket(completed, (r) => r.oldInjuryFlag),
  },
  activeExamples: completed
    .filter((r) => r.active_risk)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12)
    .map((r) => ({
      pitcher: r.pitcher,
      timing: r.risk_timing,
      conf: r.confidence,
      teamWon: r.teamWon,
      teamRA: r.teamRunsAllowed,
      starterER: r.starterER,
      starterIP: r.starterIP,
      summary: r.summary,
    })),
  directionNote: [
    '若 activeRisk 的 starterER/teamRA 明顯高、勝率明顯低，方向才算被資料支持',
    '若 activeRisk 很少且差異仍亂，表示新聞層對賽果仍弱，主方向應回投手能力／platoon／官方 IL',
  ],
};

fs.writeFileSync('tmp-intel-v2-outcome.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
