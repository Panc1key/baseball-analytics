/**
 * v4.6-rc 鎖定 B 紙上雙窗閘（@$50）
 *
 * 同一套 ev02_max230 + frozen_b+shrink + earlySoft + Top3/drop，只換期望得分模型。
 * 對照：prod v4.5、消融 base_v45、以及各 +IL / +sparse 候選。
 *
 * 用法:
 *   node scripts/auditMlbV46LockedBShadow.mjs
 *   node scripts/auditMlbV46LockedBShadow.mjs --from-ablation=tmp-v46-rc-ablation.json
 * 產物: tmp-v46-locked-b-shadow.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
  runMlbExpectedRunsV46RcAblation,
} from '../src/services/MlbExpectedRunsModel.js';
import {
  applyFrozenResidualToPrediction,
  applyFrozenToxicShrink,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = outArg
  ? path.resolve(process.cwd(), outArg.split('=')[1])
  : path.join(__dirname, '../tmp-v46-locked-b-shadow.json');

const B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;
const STAKE = 50;

const WINDOWS = [
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function books(g, c, h, a) {
  const pit = resolvePitOdds(g, c);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === h) ||
      m.outcomes.find((o) => String(o.name).includes(String(h).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === a) ||
      m.outcomes.find((o) => String(o.name).includes(String(a).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = +home.price;
    const ao = +away.price;
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}

function summarize(bets) {
  if (!bets.length) return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0 };
  let hits = 0;
  let unit = 0;
  let odds = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number((odds / n).toFixed(3)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * STAKE),
  };
}

function applyDrop(sorted) {
  let slots = sorted.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
  if (
    slots.length >= 2 &&
    slots[1].pickOdds >= DROP_R2_MIN &&
    slots[1].pickOdds < DROP_R2_MAX
  ) {
    slots = [slots[0], ...slots.slice(2)];
  }
  return slots;
}

function loadFeaturePool(from, to) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, from, to);
  const out = [];
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    features.gameId = row.gameId;
    features.commenceTime = row.commenceTime;
    features.homeTeam = row.homeTeam;
    features.awayTeam = row.awayTeam;
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) continue;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) continue;
    const sig = buildPregameRegimeSignals(features);
    out.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeWon: hs > as,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeWinPct,
      xHome: homeWinPct - 0.5,
      features,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
    });
  }
  return out;
}

function selectLockedB(pool, model) {
  const byDay = new Map();
  for (const g of pool) {
    const base = predictMlbGameRuns(model, g.features, { totalLine: 8.5 });
    const pred = applyFrozenResidualToPrediction(model, base, g.xHome);
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    if ((pickHome ? g.homeEarly : g.awayEarly) > (pickHome ? g.awayEarly : g.homeEarly)) {
      continue;
    }
    modelProb = applyFrozenToxicShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct: g.homeWinPct,
    });
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      day: g.day,
      pickHome,
      pickOdds,
      modelProb,
      ev,
      margin,
      bScore,
      hit: pickHome ? g.homeWon : !g.homeWon,
    });
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    const arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    applyDrop(arr).forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function evalModel(label, model, poolsByWindow, baselineByWindow) {
  const byWindow = {};
  const all = [];
  for (const w of WINDOWS) {
    const bets = selectLockedB(poolsByWindow[w.key], model).map((b) => ({
      ...b,
      window: w.key,
    }));
    all.push(...bets);
    const s = summarize(bets);
    const base = baselineByWindow[w.key];
    byWindow[w.key] = {
      ...s,
      deltaUsdVsBaseline: base ? s.usd50 - base.usd50 : null,
    };
  }
  const overall = summarize(all);
  const baseAll = baselineByWindow.__merged;
  return {
    label,
    featureKeys: model.featureKeys,
    overall: {
      ...overall,
      deltaUsdVsBaseline: baseAll ? overall.usd50 - baseAll.usd50 : null,
    },
    byWindow,
    paperGate: {
      mergedGtBaseline:
        baseAll != null && overall.usd50 > baseAll.usd50,
      year2025GeBaseline:
        baselineByWindow['2025'] != null &&
        byWindow['2025'].usd50 >= baselineByWindow['2025'].usd50,
      year2026GeBaseline:
        baselineByWindow['2026'] != null &&
        byWindow['2026'].usd50 >= baselineByWindow['2026'].usd50,
    },
  };
}

const fromArg = process.argv.find((a) => a.startsWith('--from-ablation='));
let ablation;
if (fromArg) {
  const p = path.resolve(process.cwd(), fromArg.split('=')[1]);
  ablation = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log('Loaded ablation from', p);
} else {
  const existing = path.join(__dirname, '../tmp-v46-rc-ablation.json');
  if (fs.existsSync(existing)) {
    ablation = JSON.parse(fs.readFileSync(existing, 'utf8'));
    console.log('Loaded existing', existing);
  } else {
    console.log('No ablation file; running v4.6-rc ablation…');
    const run = runMlbExpectedRunsV46RcAblation({ persist: false });
    ablation = {
      runId: run.runId,
      modelVersion: run.modelVersion,
      selectedKey: run.summary.selectedKey,
      modelGate: run.summary.modelGate,
      modelsByKey: run.modelsByKey,
      candidates: run.summary.candidates,
    };
  }
}

const prod = getLatestMlbExpectedRunsValidation();
if (!prod?.model) throw new Error('missing_formal_v45_model');

console.log('Loading locked-B feature pools…');
const poolsByWindow = {};
for (const w of WINDOWS) {
  poolsByWindow[w.key] = loadFeaturePool(w.from, w.to);
  console.log(w.key, 'pool', poolsByWindow[w.key].length);
}

const prodEvalSeed = evalModel('prod_v45', prod.model, poolsByWindow, {
  '2025': { usd50: 0 },
  '2026': { usd50: 0 },
  __merged: { usd50: 0 },
});
const baselineByWindow = {
  '2025': { usd50: prodEvalSeed.byWindow['2025'].usd50 },
  '2026': { usd50: prodEvalSeed.byWindow['2026'].usd50 },
  __merged: { usd50: prodEvalSeed.overall.usd50 },
};

const results = [
  evalModel('prod_v45', prod.model, poolsByWindow, baselineByWindow),
];

for (const [key, model] of Object.entries(ablation.modelsByKey || {})) {
  results.push(evalModel(key, model, poolsByWindow, baselineByWindow));
}

const selectedKey = ablation.selectedKey || 'base_v45';
const selectedPaper = results.find((r) => r.label === selectedKey);
const dualGate = {
  modelGate: ablation.modelGate || null,
  paperGate: selectedPaper?.paperGate || null,
  promoteEligible: Boolean(
    ablation.modelGate?.validationBrierOk &&
    ablation.modelGate?.observed2026BrierOk &&
    selectedPaper?.paperGate?.mergedGtBaseline &&
    selectedPaper?.paperGate?.year2025GeBaseline &&
    selectedPaper?.paperGate?.year2026GeBaseline
  ),
};

const report = {
  generatedAt: new Date().toISOString(),
  ablationRunId: ablation.runId,
  selectedKey,
  dualGate,
  baselineUsd50: baselineByWindow,
  results: results.map((r) => ({
    label: r.label,
    featureKeys: r.featureKeys,
    overall: r.overall,
    byWindow: r.byWindow,
    paperGate: r.paperGate,
  })),
  note:
    '紙上閘相對 prod_v45 鎖定 B（殘差+毒縮+earlySoft+Top3/drop）；未過雙層閘不升格。',
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  dualGate,
  baselineUsd50: baselineByWindow,
  results: report.results.map((r) => ({
    label: r.label,
    overall: r.overall,
    byWindow: {
      '2025': r.byWindow['2025'],
      '2026': r.byWindow['2026'],
    },
    paperGate: r.paperGate,
  })),
  wrote: outPath,
}, null, 2));
