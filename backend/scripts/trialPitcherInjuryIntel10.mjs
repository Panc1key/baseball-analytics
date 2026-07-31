/**
 * 抽 10 場不重複比賽，跑投手傷病情報管線並輸出摘要。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { analyzePitcherInjuryIntel } from '../src/services/PitcherInjuryIntelService.js';
import { config } from '../src/config.js';

if (!config.deepseekApiKey) {
  console.error(JSON.stringify({ ok: false, error: 'deepseek_api_key_missing' }));
  process.exit(1);
}

const games = db.prepare(`
  WITH ranked AS (
    SELECT s.game_id AS gameId,
           s.commence_time AS commenceTime,
           s.home_pitcher_id AS homePitcherId,
           s.home_pitcher_name AS homePitcherName,
           s.away_pitcher_id AS awayPitcherId,
           s.away_pitcher_name AS awayPitcherName,
           g.home_team AS homeTeam,
           g.away_team AS awayTeam,
           ROW_NUMBER() OVER (
             PARTITION BY s.game_id
             ORDER BY datetime(s.captured_at) DESC
           ) AS rn
    FROM mlb_probable_starter_snapshots s
    JOIN games g ON g.id = s.game_id
    WHERE s.status = 'complete'
      AND s.home_pitcher_name IS NOT NULL
      AND s.away_pitcher_name IS NOT NULL
  )
  SELECT gameId, commenceTime, homePitcherId, homePitcherName,
         awayPitcherId, awayPitcherName, homeTeam, awayTeam
  FROM ranked
  WHERE rn = 1
  ORDER BY datetime(commenceTime) DESC
  LIMIT 10
`).all();

console.error(`testing uniqueGames=${games.length}`);
console.error(games.map((g) =>
  `${g.commenceTime.slice(0, 10)} ${g.awayPitcherName} @ ${g.homePitcherName}`
).join('\n'));

const rows = [];
for (const [index, game] of games.entries()) {
  const started = Date.now();
  const [home, away] = await Promise.all([
    analyzePitcherInjuryIntel({
      pitcherName: game.homePitcherName,
      pitcherId: game.homePitcherId,
      teamName: game.homeTeam,
      league: 'MLB',
      gameId: `${game.gameId}:trial10`,
      commenceTime: game.commenceTime,
      force: true,
    }),
    analyzePitcherInjuryIntel({
      pitcherName: game.awayPitcherName,
      pitcherId: game.awayPitcherId,
      teamName: game.awayTeam,
      league: 'MLB',
      gameId: `${game.gameId}:trial10`,
      commenceTime: game.commenceTime,
      force: true,
    }),
  ]);

  const pack = (side, intel, name) => ({
    side,
    pitcher: name,
    ok: Boolean(intel.ok),
    status: intel.status || null,
    error: intel.error || null,
    materials: intel.materials?.length || 0,
    titles: (intel.materials || []).slice(0, 2).map((m) => m.title),
    injury_flag: intel.result?.injury_flag ?? null,
    surgery_recovery: intel.result?.surgery_recovery ?? null,
    workload_management: intel.result?.workload_management ?? null,
    confidence: intel.result?.confidence ?? null,
    summary: intel.result?.summary || null,
  });

  rows.push({
    gameId: game.gameId,
    commenceTime: game.commenceTime,
    matchup: `${game.awayTeam} @ ${game.homeTeam}`,
    ms: Date.now() - started,
    home: pack('home', home, game.homePitcherName),
    away: pack('away', away, game.awayPitcherName),
  });
  console.error(
    `[${index + 1}/10] ${game.awayPitcherName} / ${game.homePitcherName}` +
    ` mats=${home.materials?.length || 0}/${away.materials?.length || 0}` +
    ` inj=${home.result?.injury_flag ? 1 : 0}/${away.result?.injury_flag ? 1 : 0}` +
    ` surg=${home.result?.surgery_recovery ? 1 : 0}/${away.result?.surgery_recovery ? 1 : 0}`
  );
}

const pitchers = rows.flatMap((r) => [r.home, r.away]);
const summary = {
  games: rows.length,
  uniquePitchers: new Set(pitchers.map((p) => p.pitcher)).size,
  pitcherEvals: pitchers.length,
  okRate: pitchers.filter((p) => p.ok).length / Math.max(1, pitchers.length),
  withMaterials: pitchers.filter((p) => p.materials > 0).length,
  zeroMaterials: pitchers.filter((p) => p.materials === 0).length,
  injuryFlagged: pitchers.filter((p) => p.injury_flag).length,
  surgeryFlagged: pitchers.filter((p) => p.surgery_recovery).length,
  workloadFlagged: pitchers.filter((p) => p.workload_management).length,
  avgConfidence: Number((
    pitchers
      .filter((p) => p.confidence != null)
      .reduce((s, p) => s + p.confidence, 0) /
    Math.max(1, pitchers.filter((p) => p.confidence != null).length)
  ).toFixed(3)),
  avgMaterials: Number((
    pitchers.reduce((s, p) => s + p.materials, 0) / Math.max(1, pitchers.length)
  ).toFixed(2)),
  flaggedPitchers: pitchers
    .filter((p) => p.injury_flag || p.surgery_recovery || p.workload_management)
    .map((p) => ({
      pitcher: p.pitcher,
      injury_flag: p.injury_flag,
      surgery_recovery: p.surgery_recovery,
      workload_management: p.workload_management,
      confidence: p.confidence,
      summary: p.summary,
      titles: p.titles,
    })),
  healthyPitchers: pitchers
    .filter((p) => p.ok && !p.injury_flag && !p.surgery_recovery && !p.workload_management)
    .map((p) => ({ pitcher: p.pitcher, confidence: p.confidence, summary: p.summary })),
};

const out = {
  ok: summary.okRate === 1 && summary.games === 10,
  note: '10 場不重複雙先發完整管線；僅驗證檢索+旗標是否可用，非準確率標註集。',
  summary,
  games: rows,
};

fs.writeFileSync('tmp-intel-10-result.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ok: out.ok, summary: out.summary }, null, 2));
