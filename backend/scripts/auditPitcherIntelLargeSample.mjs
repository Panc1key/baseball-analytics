/**
 * 擴大傷病情報樣本：完賽場次先發 → 新聞+DeepSeek 旗標 → 對照賽果／先發個人失分。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { analyzePitcherInjuryIntel } from '../src/services/PitcherInjuryIntelService.js';
import {
  getMlbGameBoxscore,
  getMlbScheduleAround,
  matchMlbOfficialGame,
} from '../src/services/MlbStatsService.js';

const TARGET_GAMES = Number(process.argv.find((a) => a.startsWith('--games='))?.split('=')[1] || 60);
const FORCE = process.argv.includes('--force');

if (!config.deepseekApiKey) {
  console.error(JSON.stringify({ ok: false, error: 'deepseek_api_key_missing' }));
  process.exit(1);
}

const games = db.prepare(`
  WITH ranked AS (
    SELECT s.game_id AS gameId,
           s.commence_time AS commenceTime,
           s.official_game_pk AS officialGamePk,
           s.home_pitcher_id AS homePitcherId,
           s.home_pitcher_name AS homePitcherName,
           s.away_pitcher_id AS awayPitcherId,
           s.away_pitcher_name AS awayPitcherName,
           g.home_team AS homeTeam,
           g.away_team AS awayTeam,
           g.home_score AS homeScore,
           g.away_score AS awayScore,
           ROW_NUMBER() OVER (
             PARTITION BY s.game_id
             ORDER BY datetime(s.captured_at) DESC
           ) AS rn
    FROM mlb_probable_starter_snapshots s
    JOIN games g ON g.id = s.game_id
    WHERE s.status = 'complete'
      AND g.completed = 1
      AND g.home_score IS NOT NULL
      AND g.away_score IS NOT NULL
      AND s.home_pitcher_name IS NOT NULL
      AND s.away_pitcher_name IS NOT NULL
  )
  SELECT *
  FROM ranked
  WHERE rn = 1
  ORDER BY datetime(commenceTime) DESC
  LIMIT ?
`).all(TARGET_GAMES);

console.error(`selected completed games=${games.length} force=${FORCE}`);

async function resolveGamePk(game) {
  if (game.officialGamePk) return Number(game.officialGamePk);
  if (String(game.gameId).startsWith('mlb-official-')) {
    return Number(String(game.gameId).slice('mlb-official-'.length));
  }
  const schedule = await getMlbScheduleAround(game.commenceTime);
  const official = matchMlbOfficialGame({
    commence_time: game.commenceTime,
    home_team: game.homeTeam,
    away_team: game.awayTeam,
  }, schedule);
  return official?.gamePk ?? null;
}

function starterLineFromBoxscore(boxscore, pitcherId) {
  if (!boxscore || !pitcherId) return null;
  for (const side of ['home', 'away']) {
    const players = boxscore.teams?.[side]?.players || {};
    for (const player of Object.values(players)) {
      if (Number(player?.person?.id) !== Number(pitcherId)) continue;
      const pitching = player?.stats?.pitching;
      if (!pitching) continue;
      const innings = pitching.inningsPitched != null
        ? Number(String(pitching.inningsPitched).replace(/(\d+)\.1$/, '$1.333').replace(/(\d+)\.2$/, '$1.666'))
        : null;
      return {
        side,
        inningsPitched: Number.isFinite(innings) ? innings : null,
        earnedRuns: pitching.earnedRuns != null ? Number(pitching.earnedRuns) : null,
        runs: pitching.runs != null ? Number(pitching.runs) : null,
        outs: pitching.outs != null ? Number(pitching.outs) : null,
        homeRuns: pitching.homeRuns != null ? Number(pitching.homeRuns) : null,
        strikeOuts: pitching.strikeOuts != null ? Number(pitching.strikeOuts) : null,
      };
    }
  }
  // fallback: pitchers array order + player entries
  for (const side of ['home', 'away']) {
    const ids = boxscore.teams?.[side]?.pitchers || [];
    if (!ids.map(Number).includes(Number(pitcherId))) continue;
    const key = `ID${pitcherId}`;
    const player = boxscore.teams?.[side]?.players?.[key];
    const pitching = player?.stats?.pitching;
    if (!pitching) return { side, inningsPitched: null, earnedRuns: null, runs: null };
    const innings = pitching.inningsPitched != null
      ? Number(String(pitching.inningsPitched).replace(/(\d+)\.1$/, '$1.333').replace(/(\d+)\.2$/, '$1.666'))
      : null;
    return {
      side,
      inningsPitched: Number.isFinite(innings) ? innings : null,
      earnedRuns: pitching.earnedRuns != null ? Number(pitching.earnedRuns) : null,
      runs: pitching.runs != null ? Number(pitching.runs) : null,
      outs: pitching.outs != null ? Number(pitching.outs) : null,
      homeRuns: pitching.homeRuns != null ? Number(pitching.homeRuns) : null,
      strikeOuts: pitching.strikeOuts != null ? Number(pitching.strikeOuts) : null,
    };
  }
  return null;
}

function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
}

function bucket(list, pred) {
  const yes = list.filter(pred);
  const no = list.filter((r) => !pred(r));
  const metric = (rows, key) => mean(rows.map((r) => r[key]).filter((v) => v != null));
  return {
    nYes: yes.length,
    nNo: no.length,
    teamWinRateYes: metric(yes, 'teamWon'),
    teamWinRateNo: metric(no, 'teamWon'),
    teamRunsAllowedYes: metric(yes, 'teamRunsAllowed'),
    teamRunsAllowedNo: metric(no, 'teamRunsAllowed'),
    starterERYes: metric(yes, 'starterER'),
    starterERNo: metric(no, 'starterER'),
    starterIPYes: metric(yes, 'starterIP'),
    starterIPNo: metric(no, 'starterIP'),
    starterERAYes: (() => {
      const er = metric(yes, 'starterER');
      const ip = metric(yes, 'starterIP');
      return er != null && ip > 0 ? (er * 9) / ip : null;
    })(),
    starterERANo: (() => {
      const er = metric(no, 'starterER');
      const ip = metric(no, 'starterIP');
      return er != null && ip > 0 ? (er * 9) / ip : null;
    })(),
  };
}

const pitcherRows = [];
let done = 0;
for (const game of games) {
  done += 1;
  const gamePk = await resolveGamePk(game);
  let boxscore = null;
  try {
    boxscore = await getMlbGameBoxscore(gamePk);
  } catch {
    boxscore = null;
  }

  const sides = [
    {
      side: 'home',
      pitcherId: game.homePitcherId,
      pitcherName: game.homePitcherName,
      teamName: game.homeTeam,
      teamWon: Number(game.homeScore) > Number(game.awayScore) ? 1 : 0,
      teamRunsAllowed: Number(game.awayScore),
    },
    {
      side: 'away',
      pitcherId: game.awayPitcherId,
      pitcherName: game.awayPitcherName,
      teamName: game.awayTeam,
      teamWon: Number(game.awayScore) > Number(game.homeScore) ? 1 : 0,
      teamRunsAllowed: Number(game.homeScore),
    },
  ];

  for (const entry of sides) {
    const intel = await analyzePitcherInjuryIntel({
      pitcherName: entry.pitcherName,
      pitcherId: entry.pitcherId,
      teamName: entry.teamName,
      league: 'MLB',
      gameId: game.gameId,
      commenceTime: game.commenceTime,
      force: FORCE,
    });
    const line = starterLineFromBoxscore(boxscore, entry.pitcherId);
    const flags = intel.result || {};
    const materials = intel.materials || [];
    const titles = materials.map((m) => String(m.title || ''));
    pitcherRows.push({
      gameId: game.gameId,
      commenceTime: game.commenceTime,
      matchup: `${game.awayTeam} @ ${game.homeTeam}`,
      score: `${game.homeScore}-${game.awayScore}`,
      side: entry.side,
      pitcher: entry.pitcherName,
      pitcherId: entry.pitcherId,
      ok: Boolean(intel.ok),
      materials: materials.length,
      injury_flag: Boolean(flags.injury_flag),
      surgery_recovery: Boolean(flags.surgery_recovery),
      workload_management: Boolean(flags.workload_management),
      confidence: Number(flags.confidence) || 0,
      summary: flags.summary || '',
      risky: Boolean(
        flags.injury_flag || flags.surgery_recovery || flags.workload_management
      ),
      highConfRisky: Boolean(
        (flags.injury_flag || flags.surgery_recovery || flags.workload_management) &&
        Number(flags.confidence) >= 0.8
      ),
      hasInjuryWord: titles.some((t) =>
        /injur|IL|surgery|scratch|disabled|腕|肩|肘|手術|負傷/i.test(t)
      ),
      hasPromo: titles.some((t) => /betmgm|bonus code|betting odds/i.test(t)),
      hasRecap: titles.some((t) => /recap|final score|box score/i.test(t)),
      teamWon: entry.teamWon,
      teamRunsAllowed: entry.teamRunsAllowed,
      starterIP: line?.inningsPitched ?? null,
      starterER: line?.earnedRuns ?? null,
      starterRuns: line?.runs ?? null,
      starterHR: line?.homeRuns ?? null,
      boxscoreMatched: Boolean(line),
    });
  }

  if (done % 5 === 0 || done === games.length) {
    console.error(`progress ${done}/${games.length} pitchers=${pitcherRows.length}`);
  }
}

const valid = pitcherRows.filter((r) => r.ok);
const withBox = valid.filter((r) => r.boxscoreMatched && r.starterER != null);
const authenticity = {
  pitcherEvals: valid.length,
  withMaterials: valid.filter((r) => r.materials > 0).length,
  injuryFlags: valid.filter((r) => r.injury_flag).length,
  surgeryFlags: valid.filter((r) => r.surgery_recovery).length,
  workloadFlags: valid.filter((r) => r.workload_management).length,
  injuryFlagTitleSupport:
    valid.filter((r) => r.injury_flag && r.hasInjuryWord).length,
  injuryFlagNoTitleSupport:
    valid.filter((r) => r.injury_flag && !r.hasInjuryWord).length,
  promoNoise: valid.filter((r) => r.hasPromo).length,
  recapNoise: valid.filter((r) => r.hasRecap).length,
};

const outcome = {
  withTeamResult: valid.length,
  withStarterBoxscore: withBox.length,
  anyRisk: bucket(valid, (r) => r.risky),
  highConfRisk: bucket(valid, (r) => r.highConfRisky),
  injuryFlag: bucket(valid, (r) => r.injury_flag),
  surgeryOrHighConfInjury: bucket(
    valid,
    (r) => r.surgery_recovery || (r.injury_flag && r.confidence >= 0.8)
  ),
  // 先發個人失分只用有 boxscore 的子集
  starterBox_anyRisk: bucket(withBox, (r) => r.risky),
  starterBox_highConfRisk: bucket(withBox, (r) => r.highConfRisky),
  starterBox_injuryFlag: bucket(withBox, (r) => r.injury_flag),
};

const flaggedExamples = valid
  .filter((r) => r.risky)
  .sort((a, b) => b.confidence - a.confidence)
  .slice(0, 15)
  .map((r) => ({
    day: String(r.commenceTime).slice(0, 10),
    pitcher: r.pitcher,
    conf: r.confidence,
    flags: {
      injury: r.injury_flag,
      surgery: r.surgery_recovery,
      workload: r.workload_management,
    },
    teamWon: r.teamWon,
    teamRA: r.teamRunsAllowed,
    starterIP: r.starterIP,
    starterER: r.starterER,
    score: r.score,
    summary: r.summary,
  }));

const out = {
  ok: true,
  generatedAt: new Date().toISOString(),
  targetGames: TARGET_GAMES,
  actualGames: games.length,
  authenticity,
  outcome,
  flaggedExamples,
  interpretationHints: [
    '若 highConfRisk 的 starterER / teamRunsAllowed 明顯高於對照，才比較像有效風險訊號',
    '若勝率差異亂跳且樣本 <30，不要解讀成可交易 edge',
    '新聞真實性看 title support／promo／recap 雜訊比例',
  ],
};

fs.writeFileSync('tmp-intel-outcome-large.json', JSON.stringify(out, null, 2));
fs.writeFileSync('tmp-intel-outcome-large-rows.json', JSON.stringify(valid, null, 2));
console.log(JSON.stringify({
  ok: true,
  authenticity,
  outcome,
  flaggedExamples: flaggedExamples.slice(0, 8),
}, null, 2));
