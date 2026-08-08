/**
 * 大规模赛前形态标注（可断点续跑，结果进 SQLite 缓存）
 *
 *   node scripts/labelMlbGameShapeCorpus.mjs --n=800
 *   node scripts/labelMlbGameShapeCorpus.mjs --n=3000 --batch=10
 *   node scripts/labelMlbGameShapeCorpus.mjs --all
 *
 * 用法：DeepSeek Flash 给每场打 pitcher_duel / strong_home；
 * 同时记录规则判断与赛后总分，方便后面蒸馏。
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { config } from '../src/config.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { buildGameShapeShadow } from '../src/services/MlbGameShapeShadow.js';
import {
  classifyGameShapeBatch,
  countGameShapeCache,
  getCachedGameShapeLabel,
  isDeepseekConfigured,
  upsertGameShapeLabel,
  GAME_SHAPE_PROMPT_VERSION,
} from '../src/services/MlbGameShapeLlmService.js';

function argInt(flag, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!hit) return fallback;
  const n = Number(hit.slice(flag.length + 1));
  return Number.isFinite(n) ? n : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function finite(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bestTotalsAndHomeOdds(gameId, commenceTime) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) {
    return { totalsLine: null, homeOdds: null };
  }
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
  return { totalsLine: bestTot?.line ?? null, homeOdds };
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

if (!isDeepseekConfigured()) {
  console.error(JSON.stringify({ ok: false, error: 'deepseek_api_key_missing' }, null, 2));
  process.exit(1);
}

const ALL = hasFlag('--all');
const N = ALL ? 999999 : argInt('--n', 800);
const BATCH = argInt('--batch', 10);
const SLEEP_MS = argInt('--sleep-ms', 200);
const MAX_RMB = Number(
  (process.argv.find((a) => a.startsWith('--max-rmb=')) || '--max-rmb=999999').split(
    '='
  )[1] || '999999'
);
const MODEL = process.argv.find((a) => a.startsWith('--model='))?.slice(8) ||
  config.deepseekModel ||
  'deepseek-v4-flash';

const SPEND_FILE = new URL('../tmp-game-shape-spend.json', import.meta.url);
const FLASH_IN = 1;
const FLASH_OUT = 2;

function loadSpend() {
  try {
    return JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8'));
  } catch {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estRmbFlash: 0,
      batches: 0,
      notified100: false,
      updatedAt: null,
    };
  }
}

function saveSpend(spend) {
  spend.estRmbFlash = Number(
    (
      (spend.prompt_tokens / 1e6) * FLASH_IN +
      (spend.completion_tokens / 1e6) * FLASH_OUT
    ).toFixed(4)
  );
  spend.updatedAt = new Date().toISOString();
  fs.writeFileSync(SPEND_FILE, JSON.stringify(spend, null, 2));
  return spend;
}

function estRmb(usageSum) {
  return (
    (usageSum.prompt_tokens / 1e6) * FLASH_IN +
    (usageSum.completion_tokens / 1e6) * FLASH_OUT
  );
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
     ORDER BY f.commence_time DESC`
  )
  .all(MLB_BASELINE_FEATURE_VERSION);

const pending = [];
let skippedCache = 0;
let skippedNoEra = 0;

for (const row of rows) {
  if (pending.length >= N) break;
  if (getCachedGameShapeLabel(row.game_id)) {
    skippedCache += 1;
    continue;
  }
  let features;
  try {
    features = JSON.parse(row.features_json);
  } catch {
    continue;
  }
  const market = bestTotalsAndHomeOdds(row.game_id, row.commence_time);
  const facts = packFacts(row, features, market);
  if (facts.homeEra == null || facts.awayEra == null) {
    skippedNoEra += 1;
    continue;
  }
  const rule = buildGameShapeShadow({
    features,
    totalsLine: market.totalsLine,
    homeOdds: market.homeOdds,
  });
  pending.push({
    row,
    features,
    facts,
    rule,
    totalRuns: Number(row.home_score) + Number(row.away_score),
    homeWon: Number(row.home_score) > Number(row.away_score),
  });
}

console.log(
  JSON.stringify(
    {
      targetNew: N,
      pending: pending.length,
      skippedCache,
      skippedNoEra,
      model: MODEL,
      batch: BATCH,
      maxRmb: MAX_RMB,
      promptVersion: GAME_SHAPE_PROMPT_VERSION,
      cacheBefore: countGameShapeCache(),
      spendBefore: loadSpend(),
    },
    null,
    2
  )
);

let labeled = 0;
let failed = 0;
let stoppedForBudget = false;
const usageSum = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
let spend = loadSpend();

for (let i = 0; i < pending.length; i += BATCH) {
  if (spend.estRmbFlash >= MAX_RMB) {
    stoppedForBudget = true;
    console.log(
      JSON.stringify({
        stop: 'max_rmb_reached',
        estRmbFlash: spend.estRmbFlash,
        maxRmb: MAX_RMB,
      })
    );
    break;
  }
  const chunk = pending.slice(i, i + BATCH);
  const factsList = chunk.map((c) => c.facts);
  let attempt = 0;
  let out = null;
  while (attempt < 3) {
    attempt += 1;
    out = await classifyGameShapeBatch(factsList, { model: MODEL, timeoutMs: 90000 });
    if (out.ok) break;
    console.warn(`batch fail attempt=${attempt}`, out.error, out.detail || '');
    await sleep(1500 * attempt);
  }
  if (!out?.ok) {
    for (const c of chunk) {
      upsertGameShapeLabel({
        gameId: c.row.game_id,
        commenceTime: c.row.commence_time,
        facts: {
          ...c.facts,
          rulePitcherDuel: c.rule.pitcherDuel.matched,
          ruleStrongHome: c.rule.strongHome.matched,
          totalRuns: c.totalRuns,
          homeWon: c.homeWon,
        },
        label: {},
        model: MODEL,
        status: 'error',
        error: out?.error || 'unknown',
      });
      failed += 1;
    }
    continue;
  }
  if (out.usage) {
    usageSum.prompt_tokens += out.usage.prompt_tokens || 0;
    usageSum.completion_tokens += out.usage.completion_tokens || 0;
    usageSum.total_tokens += out.usage.total_tokens || 0;
    spend.prompt_tokens += out.usage.prompt_tokens || 0;
    spend.completion_tokens += out.usage.completion_tokens || 0;
    spend.total_tokens += out.usage.total_tokens || 0;
    spend.batches += 1;
    spend = saveSpend(spend);
    if (spend.estRmbFlash >= 100 && !spend.notified100) {
      spend.notified100 = true;
      spend = saveSpend(spend);
      console.log(
        JSON.stringify({
          ALERT: 'DEEPSEEK_SPEND_REACHED_100_RMB',
          estRmbFlash: spend.estRmbFlash,
          cacheHint: 'check tmp-game-shape-spend.json',
        })
      );
    }
  }
  const byId = new Map(out.games.map((g) => [String(g.id), g]));
  for (const c of chunk) {
    const llm = byId.get(String(c.row.game_id)) || {
      pitcher_duel: false,
      strong_home: false,
      confidence: 0,
      reason: 'missing_in_batch_response',
    };
    upsertGameShapeLabel({
      gameId: c.row.game_id,
      commenceTime: c.row.commence_time,
      facts: {
        ...c.facts,
        rulePitcherDuel: c.rule.pitcherDuel.matched,
        ruleStrongHome: c.rule.strongHome.matched,
        totalRuns: c.totalRuns,
        homeWon: c.homeWon,
        score: `${c.row.away_score}-${c.row.home_score}`,
      },
      label: llm,
      model: out.model || MODEL,
      usage: out.usage,
      status: 'ok',
    });
    labeled += 1;
  }
  console.log(
    `progress ${Math.min(i + BATCH, pending.length)}/${pending.length} labeled=${labeled} fail=${failed} tokens=${usageSum.total_tokens} estRmb=${spend.estRmbFlash}`
  );
  if (SLEEP_MS > 0) await sleep(SLEEP_MS);
}

const evalRows = db
  .prepare(
    `SELECT facts_json, label_json FROM mlb_game_shape_llm_cache
     WHERE prompt_version = ? AND status = 'ok'`
  )
  .all(GAME_SHAPE_PROMPT_VERSION);

function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

const parsed = evalRows.map((r) => {
  const facts = JSON.parse(r.facts_json);
  const label = JSON.parse(r.label_json);
  return {
    totalRuns: finite(facts.totalRuns),
    homeWon: Boolean(facts.homeWon),
    ruleDuel: Boolean(facts.rulePitcherDuel),
    ruleHome: Boolean(facts.ruleStrongHome),
    llmDuel: Boolean(label.pitcher_duel),
    llmHome: Boolean(label.strong_home),
    dualDuel: Boolean(facts.rulePitcherDuel) && Boolean(label.pitcher_duel),
    line: finite(facts.totalsLine),
    homeEra: finite(facts.homeEra),
    awayEra: finite(facts.awayEra),
  };
});

function bucket(predKey, truthFn) {
  const yes = parsed.filter((r) => r[predKey]);
  const tp = yes.filter(truthFn);
  return {
    n: yes.length,
    precision: yes.length ? tp.length / yes.length : null,
    meanTotal: mean(yes.map((r) => r.totalRuns).filter((x) => x != null)),
    homeWinRate: yes.length ? yes.filter((r) => r.homeWon).length / yes.length : null,
  };
}

const summary = {
  ok: true,
  generatedAt: new Date().toISOString(),
  model: MODEL,
  promptVersion: GAME_SHAPE_PROMPT_VERSION,
  thisRun: { labeled, failed, usageSum, stoppedForBudget, spend },
  cache: countGameShapeCache(),
  corpusN: parsed.length,
  baseline: {
    meanTotal: mean(parsed.map((r) => r.totalRuns).filter((x) => x != null)),
    homeWinRate: parsed.length
      ? parsed.filter((r) => r.homeWon).length / parsed.length
      : null,
  },
  ruleDuel: bucket('ruleDuel', (r) => r.totalRuns != null && r.totalRuns <= 6),
  llmDuel: bucket('llmDuel', (r) => r.totalRuns != null && r.totalRuns <= 6),
  dualDuel: bucket('dualDuel', (r) => r.totalRuns != null && r.totalRuns <= 6),
  ruleHome: bucket('ruleHome', (r) => r.homeWon),
  llmHome: bucket('llmHome', (r) => r.homeWon),
  estCostRmbFlash: {
    // 粗估：输入1元/百万 + 输出2元/百万（未计缓存命中折扣）
    input: Number(((usageSum.prompt_tokens / 1e6) * 1).toFixed(4)),
    output: Number(((usageSum.completion_tokens / 1e6) * 2).toFixed(4)),
    total: Number(
      (
        (usageSum.prompt_tokens / 1e6) * 1 +
        (usageSum.completion_tokens / 1e6) * 2
      ).toFixed(4)
    ),
  },
};

fs.writeFileSync(
  new URL('../tmp-game-shape-corpus-summary.json', import.meta.url),
  JSON.stringify(summary, null, 2)
);
console.log(JSON.stringify(summary, null, 2));
console.log('wrote tmp-game-shape-corpus-summary.json');
