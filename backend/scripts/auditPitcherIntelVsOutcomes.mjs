/**
 * 傷病情報旗標 vs 賽果：檢查「有旗標的先發」是否真的較差。
 * 不是因果證明，只看關聯是否存在。
 */
import db from '../src/db/database.js';

const rows = db.prepare(`
  SELECT c.cache_key,
         c.game_id,
         c.pitcher_id,
         c.pitcher_name,
         c.commence_time,
         c.status,
         c.flags_json,
         c.materials_json,
         g.home_team,
         g.away_team,
         g.home_score,
         g.away_score,
         g.completed
  FROM mlb_pitcher_injury_intel_cache c
  LEFT JOIN games g ON g.id = REPLACE(c.game_id, ':trial10', '')
  WHERE c.flags_json IS NOT NULL
    AND c.status IN ('ok', 'partial')
  ORDER BY datetime(c.fetched_at) DESC
`).all();

function parseFlags(json) {
  try { return JSON.parse(json); } catch { return null; }
}

function parseMaterials(json) {
  try { return JSON.parse(json || '[]'); } catch { return []; }
}

const evals = [];
for (const row of rows) {
  const flags = parseFlags(row.flags_json);
  if (!flags) continue;
  const gameId = String(row.game_id || '').replace(/:trial10$/, '');
  const materials = parseMaterials(row.materials_json);
  const risky = Boolean(
    flags.injury_flag || flags.surgery_recovery || flags.workload_management
  );
  const highConfRisky = risky && Number(flags.confidence) >= 0.8;

  // authenticity proxies from materials
  const titles = materials.map((m) => String(m.title || ''));
  const hasPromo = titles.some((t) => /betmgm|bonus code|odds|betting/i.test(t));
  const hasInjuryWord = titles.some((t) =>
    /injur|IL|surgery|scratch|disabled|腕|肩|肘|手術|負傷|離脱/i.test(t)
  );
  const hasRecapNoise = titles.some((t) =>
    /recap|final|box score|highlights/i.test(t)
  );

  let side = null;
  let runsAllowed = null;
  let teamWon = null;
  let actualTotal = null;
  if (row.completed && row.home_score != null && row.away_score != null) {
    actualTotal = Number(row.home_score) + Number(row.away_score);
    // 判斷這位投手是主還是客：用名字對 probable snapshot / 隊名較難；用 cache 裡 pitcher 對照近期 snapshot
    const snap = db.prepare(`
      SELECT home_pitcher_name, away_pitcher_name, home_pitcher_id, away_pitcher_id
      FROM mlb_probable_starter_snapshots
      WHERE game_id = ? AND status = 'complete'
      ORDER BY datetime(captured_at) DESC
      LIMIT 1
    `).get(gameId);
    if (snap) {
      if (
        snap.home_pitcher_name === row.pitcher_name ||
        snap.home_pitcher_id === row.pitcher_id
      ) {
        side = 'home';
        runsAllowed = Number(row.away_score);
        teamWon = Number(row.home_score) > Number(row.away_score) ? 1 : 0;
      } else if (
        snap.away_pitcher_name === row.pitcher_name ||
        snap.away_pitcher_id === row.pitcher_id
      ) {
        side = 'away';
        runsAllowed = Number(row.home_score);
        teamWon = Number(row.away_score) > Number(row.home_score) ? 1 : 0;
      }
    }
  }

  evals.push({
    gameId,
    pitcher: row.pitcher_name,
    commenceTime: row.commence_time,
    completed: Boolean(row.completed),
    risky,
    highConfRisky,
    injury_flag: Boolean(flags.injury_flag),
    surgery_recovery: Boolean(flags.surgery_recovery),
    workload_management: Boolean(flags.workload_management),
    confidence: Number(flags.confidence) || 0,
    summary: flags.summary || '',
    materials: materials.length,
    hasPromo,
    hasInjuryWord,
    hasRecapNoise,
    side,
    runsAllowed,
    teamWon,
    actualTotal,
    homeScore: row.home_score,
    awayScore: row.away_score,
  });
}

// dedupe by gameId+pitcher keep latest
const seen = new Set();
const unique = [];
for (const row of evals) {
  const key = `${row.gameId}::${row.pitcher}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(row);
}

const completed = unique.filter((r) => r.completed && r.runsAllowed != null);
const mean = (arr) => arr.length
  ? arr.reduce((s, v) => s + v, 0) / arr.length
  : null;

function bucket(list, pred) {
  const yes = list.filter(pred);
  const no = list.filter((r) => !pred(r));
  return {
    nYes: yes.length,
    nNo: no.length,
    winRateYes: mean(yes.map((r) => r.teamWon)),
    winRateNo: mean(no.map((r) => r.teamWon)),
    runsAllowedYes: mean(yes.map((r) => r.runsAllowed)),
    runsAllowedNo: mean(no.map((r) => r.runsAllowed)),
    examplesYes: yes.slice(0, 8).map((r) => ({
      pitcher: r.pitcher,
      conf: r.confidence,
      runsAllowed: r.runsAllowed,
      teamWon: r.teamWon,
      score: `${r.homeScore}-${r.awayScore}`,
      summary: r.summary,
    })),
  };
}

const authenticity = {
  samples: unique.length,
  withMaterials: unique.filter((r) => r.materials > 0).length,
  titleHasInjuryWord: unique.filter((r) => r.hasInjuryWord).length,
  titleHasPromoNoise: unique.filter((r) => r.hasPromo).length,
  titleHasRecapNoise: unique.filter((r) => r.hasRecapNoise).length,
  // 若標了 injury_flag，標題是否也有傷病詞（粗一致性）
  injuryFlagAndTitleSupport: unique.filter((r) =>
    r.injury_flag && r.hasInjuryWord
  ).length,
  injuryFlagTotal: unique.filter((r) => r.injury_flag).length,
  injuryFlagWithoutTitleSupport: unique.filter((r) =>
    r.injury_flag && !r.hasInjuryWord
  ).length,
};

const outcome = {
  completedPitcherEvals: completed.length,
  anyRiskFlag: bucket(completed, (r) => r.risky),
  highConfRisk: bucket(completed, (r) => r.highConfRisky),
  injuryFlagOnly: bucket(completed, (r) => r.injury_flag),
};

console.log(JSON.stringify({
  note: '關聯檢驗，非因果；樣本來自目前快取（含 10 場試跑）。',
  authenticity,
  outcome,
  caveat: [
    '新聞標題含廣告／賽後復盤，真實性只能粗驗',
    '失分是全隊總失分，不是該先發個人局數失分',
    '樣本小，方向僅供判斷功能是否「可能有用」',
  ],
}, null, 2));
