/**
 * 賽果對帳完整性：紙上注 / 歷史特徵列 是否同一 game_id 結算
 * 產物：tmp-settle-match-integrity.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';

function evaluateH2h(pick, game) {
  if (game.home_score == null || game.away_score == null || !game.completed) return null;
  if (pick === game.home_team) {
    return Number(game.home_score) > Number(game.away_score) ? 'win' : 'loss';
  }
  if (pick === game.away_team) {
    return Number(game.away_score) > Number(game.home_score) ? 'win' : 'loss';
  }
  return 'pick_name_mismatch';
}

// 1) 紙上帳：每注必須用自己的 game_id 結算
const paper = db
  .prepare(
    `SELECT b.id, b.game_id, b.pick, b.result, b.odds_decimal,
            g.home_team, g.away_team, g.home_score, g.away_score, g.completed, g.commence_time
     FROM mlb_paper_bets b
     JOIN games g ON g.id = b.game_id
     WHERE b.market = 'h2h'`
  )
  .all();

const paperIssues = [];
let paperOk = 0;
for (const b of paper) {
  const expected = evaluateH2h(b.pick, b);
  if (expected === 'pick_name_mismatch') {
    paperIssues.push({
      id: b.id,
      type: 'pick_not_home_or_away_exact',
      pick: b.pick,
      home: b.home_team,
      away: b.away_team,
      storedResult: b.result,
    });
    continue;
  }
  if (b.result === 'pending' || b.result == null) {
    if (expected === 'win' || expected === 'loss') {
      paperIssues.push({
        id: b.id,
        type: 'should_be_settled',
        pick: b.pick,
        expected,
        final: `${b.away_score}-${b.home_score}`,
      });
    }
    continue;
  }
  if (expected && b.result !== expected && (b.result === 'win' || b.result === 'loss')) {
    paperIssues.push({
      id: b.id,
      type: 'stored_result_disagree_with_same_game_score',
      pick: b.pick,
      matchup: `${b.away_team} @ ${b.home_team}`,
      final: `${b.away_score}-${b.home_score}`,
      storedResult: b.result,
      expectedFromSameGameId: expected,
    });
  } else if (expected === b.result) {
    paperOk += 1;
  }
}

// 2) 歷史特徵：同一 game_id 的 features 對應唯一完賽比分
const hist = db
  .prepare(
    `SELECT f.game_id AS gameId, COUNT(*) AS n,
            COUNT(DISTINCT g.home_score || '-' || g.away_score) AS scoreVariants,
            MIN(g.home_team) AS home, MIN(g.away_team) AS away
     FROM mlb_historical_feature_rows f
     JOIN games g ON g.id = f.game_id
     WHERE f.feature_version = ?
       AND g.completed = 1 AND g.home_score IS NOT NULL
     GROUP BY f.game_id
     HAVING scoreVariants > 1 OR n > 3`
  )
  .all(MLB_BASELINE_FEATURE_VERSION);

// 3) 同日同對陣多場（雙辦）— 若只靠隊名+日期對會混
const doubleheaders = db
  .prepare(
    `SELECT date(commence_time) AS d, home_team, away_team, COUNT(*) AS n,
            GROUP_CONCAT(id) AS ids,
            GROUP_CONCAT(home_score || '-' || away_score) AS scores
     FROM games
     WHERE league = 'MLB' AND completed = 1
       AND date(commence_time) >= date('2024-04-01')
     GROUP BY date(commence_time), home_team, away_team
     HAVING n > 1
     ORDER BY d DESC
     LIMIT 20`
  )
  .all();

// 4) 審計腳本風險：用隊名模糊 match books（含 split(' ').pop()）— 列出可能撞名
const ambiguous = db
  .prepare(
    `SELECT home_team, away_team, COUNT(*) AS n
     FROM games WHERE league='MLB'
     GROUP BY home_team, away_team`
  )
  .all()
  .filter((r) => {
    const hp = String(r.home_team).split(' ').pop();
    const ap = String(r.away_team).split(' ').pop();
    return hp === ap; // 極少
  });

// 5) 紙上逐筆清單（給用戶核對，不是摘要糊弄）
const paperLines = paper
  .filter((b) => b.result === 'win' || b.result === 'loss')
  .map((b) => ({
    id: b.id,
    gameId: b.game_id,
    matchup: `${b.away_team} @ ${b.home_team}`,
    pick: b.pick,
    odds: b.odds_decimal,
    final: `${b.away_score}-${b.home_score}`,
    result: b.result,
    recompute: evaluateH2h(b.pick, b),
    sameGameOk: evaluateH2h(b.pick, b) === b.result,
    commence: b.commence_time,
  }));

const report = {
  experimentId: 'settle-match-integrity-2026-08-07',
  howSettlementWorks: {
    paper:
      'mlb_paper_bets.game_id → games.id；用 pick===home_team/away_team 比同一場 home_score/away_score',
    historicalAudits:
      'mlb_historical_feature_rows.game_id JOIN games.id；hit 用同一 row 的 hs/as，不是靠隊名跨場對',
    knownRisk:
      '賠率解析曾用隊名 includes/末詞模糊匹配（只影響抓哪家賠率，不影響用哪個 game_id 的比分）。人工摘要若只寫隊名+日期、不寫 game_id，才可能講錯場。',
  },
  paper: {
    total: paper.length,
    settledAgreeSameGameId: paperOk,
    issues: paperIssues,
    issueCount: paperIssues.length,
    settledLines: paperLines,
  },
  historicalFeatureJoin: {
    multiScoreSameGameId: hist.length,
    samples: hist.slice(0, 10),
  },
  doubleheadersRecent: doubleheaders,
  ambiguousTeamNameEnds: ambiguous.slice(0, 10),
  verdict: {
    paperSettlementTrusted:
      paperIssues.filter((i) => i.type === 'stored_result_disagree_with_same_game_score')
        .length === 0,
    plainSpeak: '',
  },
};

const disagree = paperIssues.filter(
  (i) => i.type === 'stored_result_disagree_with_same_game_score'
).length;
report.verdict.plainSpeak =
  disagree === 0
    ? `紙上已結算 ${paperOk} 注：用同一 game_id 重算賽果，與庫內 result 全部一致。歷史審計也是 game_id JOIN，不是靠「今天推薦A、賽果拿B」。你提的「講成全勝但其實錯場」屬於對話摘要/對錯場風險，不是這套 JOIN 結算邏輯在偷換比分。`
    : `發現 ${disagree} 筆紙上 result 與同一 game_id 比分不一致——帳本不可信，需先修結算。`;

fs.writeFileSync(
  new URL('../tmp-settle-match-integrity.json', import.meta.url),
  JSON.stringify(report, null, 2)
);
console.log(report.verdict.plainSpeak);
console.log('issues', paperIssues);
console.log(
  'paper lines',
  paperLines.map((l) => `${l.id} ${l.matchup} pick=${l.pick} ${l.final} ${l.result} ok=${l.sameGameOk}`)
);
console.log('doubleheaders', doubleheaders.length);
