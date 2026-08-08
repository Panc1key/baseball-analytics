/**
 * DeepSeek vs 规则：赛前认不认得「投手对决 / 强主」
 *
 *   node scripts/trialDeepseekGameShape.mjs
 *   node scripts/trialDeepseekGameShape.mjs --n=40
 *
 * 只把数字给 LLM（不搜新闻），对比：
 * - 规则影子 MlbGameShapeShadow
 * - DeepSeek 形态判断
 * - 赛后真相（总分低不算投手战结果；主胜）
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import {
  buildGameShapeShadow,
  detectPitcherDuel,
  detectStrongHome,
} from '../src/services/MlbGameShapeShadow.js';
import { isDeepseekConfigured } from '../src/services/PitcherInjuryIntelService.js';

function argInt(flag, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!hit) return fallback;
  const n = Number(hit.slice(flag.length + 1));
  return Number.isFinite(n) ? n : fallback;
}

function finite(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bestTotalsAndHomeOdds(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return { totalsLine: null, homeOdds: null, homeTeam: pit?.home_team };
  let bestTot = null;
  let homeOdds = null;
  const homeTeam = pit.home_team;
  for (const book of pit.bookmakers) {
    const h2h = book.markets?.find((m) => m.key === 'h2h');
    if (h2h && homeTeam) {
      const home = h2h.outcomes?.find((o) => o.name === homeTeam);
      if (home?.price && (homeOdds == null || Number(home.price) < homeOdds)) {
        homeOdds = Number(home.price);
      }
    }
    const tot = book.markets?.find((m) => m.key === 'totals');
    if (!tot) continue;
    for (const over of tot.outcomes || []) {
      if (over.name !== 'Over' || !Number.isFinite(Number(over.point))) continue;
      const under = tot.outcomes.find(
        (o) => o.name === 'Under' && Number(o.point) === Number(over.point)
      );
      if (!over.price || !under?.price) continue;
      const vig = 1 / Number(over.price) + 1 / Number(under.price);
      const cand = { line: Number(over.point), vig };
      if (!bestTot || vig < bestTot.vig) bestTot = cand;
    }
  }
  return {
    totalsLine: bestTot?.line ?? null,
    homeOdds,
    homeTeam,
  };
}

function packFacts(row, features, market) {
  return {
    id: row.game_id,
    matchup: `${row.away_team} @ ${row.home_team}`,
    homePitcher: features?.pitchers?.homeIdentity?.name || null,
    awayPitcher: features?.pitchers?.awayIdentity?.name || null,
    homeEra: finite(features?.pitchers?.home?.era),
    awayEra: finite(features?.pitchers?.away?.era),
    homeRecentEra: finite(features?.pitchers?.homeRecent?.recent3Era),
    awayRecentEra: finite(features?.pitchers?.awayRecent?.recent3Era),
    homeRpg: finite(features?.home?.recentRunsPerGame),
    awayRpg: finite(features?.away?.recentRunsPerGame),
    totalsLine: market.totalsLine,
    homeOdds: market.homeOdds,
  };
}

async function askDeepseekBatch(factsList) {
  const baseUrl = String(config.deepseekBaseUrl || 'https://api.deepseek.com').replace(
    /\/$/,
    ''
  );
  const system = `你是棒球赛前形态判读助手，不是投注顾问。
只根据提供的数字判断每场：
- pitcher_duel：双方先发都不差，且总分开得偏低，像投手战（应偏小球）
- strong_home：主队明显更强/市场主胜赔率偏低（应偏主胜）
材料不足就 false + 低 confidence。禁止编造未给出的信息。
只输出 JSON：{"games":[{"id":"...","pitcher_duel":bool,"strong_home":bool,"confidence":0到1,"reason":"一句话中文"}]}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel || 'deepseek-chat',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'classify_game_shape_batch_v0',
            games: factsList,
          }),
        },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`deepseek_http_${response.status}: ${detail.slice(0, 300)}`);
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {};
  }
  return {
    games: Array.isArray(parsed.games) ? parsed.games : [],
    usage: payload.usage || null,
    model: payload.model || config.deepseekModel,
  };
}

function summarizeCatch(rows, predKey, truthFn) {
  const predYes = rows.filter((r) => r[predKey]);
  const truthYes = rows.filter((r) => truthFn(r));
  const tp = rows.filter((r) => r[predKey] && truthFn(r)).length;
  const fp = rows.filter((r) => r[predKey] && !truthFn(r)).length;
  const fn = rows.filter((r) => !r[predKey] && truthFn(r)).length;
  const meanTotalPred = predYes.length
    ? predYes.reduce((s, r) => s + r.totalRuns, 0) / predYes.length
    : null;
  const homeWinWhenPred = predYes.length
    ? predYes.filter((r) => r.homeWon).length / predYes.length
    : null;
  return {
    predicted: predYes.length,
    truth: truthYes.length,
    precision: predYes.length ? tp / predYes.length : null,
    recall: truthYes.length ? tp / truthYes.length : null,
    tp,
    fp,
    fn,
    meanTotalWhenPredicted: meanTotalPred,
    homeWinRateWhenPredicted: homeWinWhenPred,
  };
}

const N = argInt('--n', 40);
const BATCH = argInt('--batch', 8);

if (!isDeepseekConfigured()) {
  console.error(JSON.stringify({ ok: false, error: 'deepseek_api_key_missing' }, null, 2));
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT f.game_id, f.commence_time, f.features_json,
            g.home_team, g.away_team, g.home_score, g.away_score
     FROM mlb_historical_feature_rows f
     JOIN games g ON g.id = f.game_id
     WHERE f.feature_version = ?
       AND g.home_score IS NOT NULL
       AND g.away_score IS NOT NULL
       AND f.commence_time >= '2026-06-01'
     ORDER BY f.commence_time DESC
     LIMIT ?`
  )
  .all(MLB_BASELINE_FEATURE_VERSION, N * 3);

const samples = [];
for (const row of rows) {
  if (samples.length >= N) break;
  let features;
  try {
    features = JSON.parse(row.features_json);
  } catch {
    continue;
  }
  const market = bestTotalsAndHomeOdds(row.game_id, row.commence_time);
  if (market.totalsLine == null && market.homeOdds == null) continue;
  const facts = packFacts(row, features, market);
  if (facts.homeEra == null || facts.awayEra == null) continue;
  const rule = buildGameShapeShadow({
    features,
    totalsLine: market.totalsLine,
    homeOdds: market.homeOdds,
  });
  const totalRuns = Number(row.home_score) + Number(row.away_score);
  const homeWon = Number(row.home_score) > Number(row.away_score);
  samples.push({
    ...facts,
    features,
    rulePitcherDuel: rule.pitcherDuel.matched,
    ruleStrongHome: rule.strongHome.matched,
    rulePlain: rule.routes.plain,
    totalRuns,
    homeWon,
    score: `${row.away_score}-${row.home_score}`,
    trueLowTotal: totalRuns <= 5,
    truePitcherIsh: totalRuns <= 6,
  });
}

console.log(`[game-shape] samples=${samples.length}, calling DeepSeek in batches of ${BATCH}…`);

const llmById = new Map();
let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
let model = config.deepseekModel;

for (let i = 0; i < samples.length; i += BATCH) {
  const chunk = samples.slice(i, i + BATCH);
  const factsList = chunk.map((s) => ({
    id: s.id,
    matchup: s.matchup,
    homePitcher: s.homePitcher,
    awayPitcher: s.awayPitcher,
    homeEra: s.homeEra,
    awayEra: s.awayEra,
    homeRecentEra: s.homeRecentEra,
    awayRecentEra: s.awayRecentEra,
    homeRpg: s.homeRpg,
    awayRpg: s.awayRpg,
    totalsLine: s.totalsLine,
    homeOdds: s.homeOdds,
  }));
  const out = await askDeepseekBatch(factsList);
  model = out.model || model;
  if (out.usage) {
    totalUsage.prompt_tokens += out.usage.prompt_tokens || 0;
    totalUsage.completion_tokens += out.usage.completion_tokens || 0;
    totalUsage.total_tokens += out.usage.total_tokens || 0;
  }
  for (const g of out.games) {
    llmById.set(String(g.id), g);
  }
  console.log(`  batch ${i / BATCH + 1} ok, got ${out.games.length} labels`);
}

const scored = samples.map((s) => {
  const llm = llmById.get(String(s.id)) || {};
  return {
    matchup: s.matchup,
    score: s.score,
    totalRuns: s.totalRuns,
    homeWon: s.homeWon,
    totalsLine: s.totalsLine,
    homeOdds: s.homeOdds,
    eras: [s.awayEra, s.homeEra],
    trueLowTotal: s.trueLowTotal,
    truePitcherIsh: s.truePitcherIsh,
    rulePitcherDuel: s.rulePitcherDuel,
    ruleStrongHome: s.ruleStrongHome,
    llmPitcherDuel: Boolean(llm.pitcher_duel),
    llmStrongHome: Boolean(llm.strong_home),
    llmConfidence: llm.confidence ?? null,
    llmReason: llm.reason || null,
    rulePlain: s.rulePlain,
    agreeDuel: s.rulePitcherDuel === Boolean(llm.pitcher_duel),
    agreeHome: s.ruleStrongHome === Boolean(llm.strong_home),
  };
});

const out = {
  ok: true,
  generatedAt: new Date().toISOString(),
  model,
  usage: totalUsage,
  n: scored.length,
  baselineMeanTotal:
    scored.reduce((s, r) => s + r.totalRuns, 0) / Math.max(1, scored.length),
  baselineHomeWinRate: scored.filter((r) => r.homeWon).length / Math.max(1, scored.length),
  rulePitcherDuel: summarizeCatch(scored, 'rulePitcherDuel', (r) => r.truePitcherIsh),
  llmPitcherDuel: summarizeCatch(scored, 'llmPitcherDuel', (r) => r.truePitcherIsh),
  ruleStrongHome: summarizeCatch(scored, 'ruleStrongHome', (r) => r.homeWon),
  llmStrongHome: summarizeCatch(scored, 'llmStrongHome', (r) => r.homeWon),
  agreement: {
    duel: scored.filter((r) => r.agreeDuel).length / Math.max(1, scored.length),
    strongHome: scored.filter((r) => r.agreeHome).length / Math.max(1, scored.length),
  },
  // 真正打出极低分的场，规则/LLM 赛前抓到了吗
  missedTrueLowTotal: scored
    .filter((r) => r.trueLowTotal && !r.rulePitcherDuel && !r.llmPitcherDuel)
    .slice(0, 10),
  caughtByLlmOnly: scored
    .filter((r) => r.truePitcherIsh && r.llmPitcherDuel && !r.rulePitcherDuel)
    .slice(0, 8),
  caughtByRuleOnly: scored
    .filter((r) => r.truePitcherIsh && r.rulePitcherDuel && !r.llmPitcherDuel)
    .slice(0, 8),
  sample: scored.slice(0, 12),
  plainChinese: null,
};

out.plainChinese = {
  结论草稿: '见控制台摘要',
  规则认投手战场次均分: out.rulePitcherDuel.meanTotalWhenPredicted,
  LLM认投手战场次均分: out.llmPitcherDuel.meanTotalWhenPredicted,
  全体均分: out.baselineMeanTotal,
  规则强主主胜率: out.ruleStrongHome.homeWinRateWhenPredicted,
  LLM强主主胜率: out.llmStrongHome.homeWinRateWhenPredicted,
  全体主胜率: out.baselineHomeWinRate,
};

fs.writeFileSync(
  new URL('../tmp-deepseek-game-shape-trial.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

function pct(x) {
  return x == null ? null : Number((x * 100).toFixed(1));
}

console.log(
  JSON.stringify(
    {
      n: out.n,
      usage: out.usage,
      baselineMeanTotal: Number(out.baselineMeanTotal.toFixed(2)),
      ruleDuel: {
        n: out.rulePitcherDuel.predicted,
        precisionPct: pct(out.rulePitcherDuel.precision),
        meanTotal: out.rulePitcherDuel.meanTotalWhenPredicted,
      },
      llmDuel: {
        n: out.llmPitcherDuel.predicted,
        precisionPct: pct(out.llmPitcherDuel.precision),
        meanTotal: out.llmPitcherDuel.meanTotalWhenPredicted,
      },
      ruleStrongHome: {
        n: out.ruleStrongHome.predicted,
        homeWinPct: pct(out.ruleStrongHome.homeWinRateWhenPredicted),
      },
      llmStrongHome: {
        n: out.llmStrongHome.predicted,
        homeWinPct: pct(out.llmStrongHome.homeWinRateWhenPredicted),
      },
      agreementPct: {
        duel: pct(out.agreement.duel),
        strongHome: pct(out.agreement.strongHome),
      },
    },
    null,
    2
  )
);
console.log('wrote tmp-deepseek-game-shape-trial.json');
