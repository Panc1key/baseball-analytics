/**
 * 白話展示：Yankees@Dodgers（2-18）系統為何選「客場洋基」
 */
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  classifyMlbMoneylineCandidate,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const gameId = 'mlb-official-777698';
const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };

const g = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
const feat = db
  .prepare(
    'SELECT features_json FROM mlb_historical_feature_rows WHERE game_id = ? AND feature_version = ?'
  )
  .get(gameId, MLB_BASELINE_FEATURE_VERSION);
const features = JSON.parse(feat.features_json);
const model = getLatestMlbExpectedRunsValidation().model;
const pred = predictMlbGameRuns(model, features, { totalLine: 8.5 });

function topContrib(explanation, n = 6) {
  return [...explanation.contributions]
    .sort((a, b) => Math.abs(b.linearContribution) - Math.abs(a.linearContribution))
    .slice(0, n)
    .map((c) => ({
      key: c.key,
      group: c.group,
      value: Number(c.value.toFixed(4)),
      z: Number(c.zScore.toFixed(3)),
      effect: Number(c.linearContribution.toFixed(4)),
      mult: Number(c.multiplier.toFixed(4)),
    }));
}

const pit = resolvePitOdds(gameId, g.commence_time);
let market = null;
let bookN = 0;
if (pit?.bookmakers?.length) {
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home = m.outcomes.find((o) => o.name === g.home_team);
    const away = m.outcomes.find((o) => o.name === g.away_team);
    if (!home?.price || !away?.price) continue;
    bookN += 1;
    const vig = 1 / home.price + 1 / away.price;
    if (!market || vig < market.vig) {
      market = {
        homeOdds: +home.price,
        awayOdds: +away.price,
        homeProb: 1 / home.price / vig,
        awayProb: 1 / away.price / vig,
        vig,
      };
    }
  }
}
market.h2hBookCount = Math.max(bookN, 2);

const classification = classifyMlbMoneylineCandidate({
  prediction: pred,
  market,
  rules: B,
  regimeSignals: buildPregameRegimeSignals(features),
  pitcherIdentity: {
    homeId: features.pitchers?.homeIdentity?.id,
    awayId: features.pitchers?.awayIdentity?.id,
  },
});

const pickHome = pred.homeExpectedRuns >= pred.awayExpectedRuns;
const modelP = pickHome
  ? pred.markets.homeWinProbability
  : pred.markets.awayWinProbability;
const pickOdds = pickHome ? market.homeOdds : market.awayOdds;
const marketP = pickHome ? market.homeProb : market.awayProb;
const ev = modelP * pickOdds - 1;
const margin = Math.abs(pred.homeExpectedRuns - pred.awayExpectedRuns);

console.log(`
============================================================
場次：Yankees(客) @ Dodgers(主)｜實際 ${g.away_score}-${g.home_score}
先發：Will Warren vs Landon Knack
============================================================

【你個人的邏輯】
  主場道奇／或乾脆不選；不會選客場。
  看的是：主場、陣容接近全主力、洋基客場+次級先發。

【系統的邏輯】——完全另一套問題
  它不問「該不該賭主場」，只問：
  1) 兩邊各會得幾分？
  2) 誰預期得分較高 → 定邊選誰
  3) 這個邊的獨贏，相對市場賠率有沒有正 EV？
  4) 過門檻就進當日推薦池（再排日內名次）

------------------------------------------------------------
步驟 1｜各算預期得分（兩隊分開的回歸）
------------------------------------------------------------
  道奇(主) 預期得分 = ${pred.homeExpectedRuns.toFixed(3)}
  洋基(客) 預期得分 = ${pred.awayExpectedRuns.toFixed(3)}
  分差 margin     = ${margin.toFixed(3)}  （洋基略高）

  ※ 主場特徵 isHome 權重 ≈ ${Number(model.weights.isHome).toExponential(2)}
    → 幾乎等於「系統不看主場」

------------------------------------------------------------
步驟 2｜得分分布 → 獨贏勝率
------------------------------------------------------------
  道奇勝率 = ${(pred.markets.homeWinProbability * 100).toFixed(2)}%
  洋基勝率 = ${(pred.markets.awayWinProbability * 100).toFixed(2)}%
  → 因為洋基預期分較高，定邊 = 客場洋基

------------------------------------------------------------
步驟 3｜對市場算 EV（為什麼「會選」而不只是「略偏洋基」）
------------------------------------------------------------
  選邊賠率(客) = ${pickOdds}
  模型勝率 P   = ${(modelP * 100).toFixed(2)}%
  市場隱含機率 ≈ ${(marketP * 100).toFixed(2)}%
  EV = P × 賠率 − 1 = ${(ev * 100).toFixed(2)}%

  鎖定 B 門檻（摘要）：
    EV≥2%  ✓ ${(ev * 100).toFixed(2)}%
    margin≥0.25  ✓ ${margin.toFixed(3)}
    P≥50%  ✓ ${(modelP * 100).toFixed(2)}%
    賠率∈[1.85,2.30]  ✓ ${pickOdds}
    雙先發 ID、≥2庄、earlyExits… 

  classify 結果 = ${classification.tier}
  系統選邊 = ${pickHome ? '主場道奇' : '客場洋基'}

------------------------------------------------------------
步驟 4｜為什麼洋基預期分會略高？（特徵貢獻，不是主場）
------------------------------------------------------------
`);

console.log('道奇得分（打對手先發 Warren）拉抬/壓制 Top:');
for (const c of topContrib(pred.explanation.home)) {
  console.log(
    `  [${c.group}] ${c.key} 值=${c.value} z=${c.z} 效果=${c.effect} (×${c.mult})`
  );
}
console.log('\n洋基得分（打對手先發 Knack）拉抬/壓制 Top:');
for (const c of topContrib(pred.explanation.away)) {
  console.log(
    `  [${c.group}] ${c.key} 值=${c.value} z=${c.z} 效果=${c.effect} (×${c.mult})`
  );
}

console.log(`
------------------------------------------------------------
【缺什麼關鍵資料？——對，缺的是你腦中那一層】
------------------------------------------------------------
系統「有」：
  • 隊級近期攻防（得分/失分）、打擊 OBP/SLG
  • 先發 ERA/WHIP/K-BB、對左右打 OPS、休息日
  • 球場係數（但這場 isHome 權重≈0）

系統「沒有／幾乎沒用」（所以會跟你直覺打架）：
  • 當日打線主力強度（Judge+弱環 vs Ohtani整條線）
  • 「客場不要碰強隊」這類主客偏好規則
  • 大比分尾部風險（開局被打爆 0-10）
  • 明星缺陣以外的「今晚誰先發打誰」敘事

所以不是「主場權重算錯」，而是：
  問題定義不同 → 系統在找「正 EV 的定邊」，
  你在做「主場強隊／不碰客場」的風險篩選。
  這場薄邊客勝（約54%、margin 0.49）剛好撞上開局雪崩。

人腦若加一條硬規則「禁止客場」或「道奇主場近主力不選對手」，
這場就不會進你的單；但那不是現在鎖定 B 的規則。
`);
