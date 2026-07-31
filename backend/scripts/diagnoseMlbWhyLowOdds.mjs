/**
 * 診斷：為何擋 &lt;1.85？低賠為何仍會輸？
 * 只分析、不改規則。產物：tmp-why-low-odds.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  predictMlbGameRuns,
  scoreMlbMoneylineDailyRank,
  MLB_MONEYLINE_RULE_PROFILES,
} from '../src/services/MlbExpectedRunsModel.js';
import {
  applyFrozenResidualToPrediction,
  applyFrozenToxicShrink,
} from '../src/services/MlbFrozenBShadow.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const RULES = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const WINDOWS = [
  { from: '2025-04-01', to: '2025-09-30' },
  { from: '2026-04-01', to: '2026-07-28' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function books(gameId, commenceTime, homeTeam, awayTeam) {
  const pit = resolvePitOdds(gameId, commenceTime);
  if (!pit?.bookmakers?.length) return [];
  const out = [];
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === homeTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(homeTeam).split(' ').pop()));
    const away =
      m.outcomes.find((o) => o.name === awayTeam) ||
      m.outcomes.find((o) => String(o.name).includes(String(awayTeam).split(' ').pop()));
    if (!home?.price || !away?.price) continue;
    const ho = Number(home.price);
    const ao = Number(away.price);
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    out.push({ homeOdds: ho, awayOdds: ao, vig: 1 / ho + 1 / ao });
  }
  return out;
}

function band(odds) {
  if (odds < 1.5) return '<1.50';
  if (odds < 1.7) return '1.50–1.70';
  if (odds < 1.85) return '1.70–1.85';
  if (odds < 1.95) return '1.85–1.95（現行可選低段）';
  if (odds < 2.1) return '1.95–2.10';
  if (odds <= 2.3) return '2.10–2.30';
  return '>2.30';
}

function be(odds) {
  return 1 / odds; // 打平所需勝率
}

function summarize(rows) {
  if (!rows.length) return { n: 0, hr: null, usd50: 0, needHr: null, gapPp: null };
  let hits = 0;
  let unit = 0;
  let need = 0;
  for (const r of rows) {
    need += be(r.pickOdds);
    if (r.hit) {
      hits += 1;
      unit += r.pickOdds - 1;
    } else unit -= 1;
  }
  const n = rows.length;
  const hr = hits / n;
  const needHr = need / n;
  return {
    n,
    hits,
    hr: Number(hr.toFixed(4)),
    needHr: Number(needHr.toFixed(4)),
    gapPp: Number(((hr - needHr) * 100).toFixed(2)),
    usd50: Math.round(unit * 50),
    avgOdds: Number((rows.reduce((s, r) => s + r.pickOdds, 0) / n).toFixed(3)),
  };
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;

/** 模型選邊後的所有「有盤＋有先發＋有預測」場（不套 EV/minOdds 門檻） */
const modelSideAll = [];
/** 現行正式選注（含門檻＋Top3結構） */
const formal = [];

const byDayPool = new Map();

for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND date(f.commence_time) >= date(?) AND date(f.commence_time) <= date(?)
       ORDER BY f.commence_time`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, w.from, w.to);

  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (hs === as) continue;

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

    const base = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const adj = applyFrozenResidualToPrediction(model, base, homeWinPct - 0.5, {
      totalLine: 8.5,
    });
    const ph = adj.homeExpectedRuns;
    const pa = adj.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? Number(adj.markets?.homeWinProbability)
      : Number(adj.markets?.awayWinProbability);
    if (!Number.isFinite(modelProb)) continue;

    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    const hit = pickHome === hs > as;
    const margin = Math.abs(ph - pa);

    modelSideAll.push({
      pickOdds,
      hit,
      band: band(pickOdds),
      pickHome,
      modelProbRaw: modelProb,
      margin,
    });

    // 正式路徑：shrink + 門檻
    modelProb = applyFrozenToxicShrink(modelProb, pickOdds, { pickHome, homeWinPct });
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    if (pickOdds < RULES.minimumPickOdds || pickOdds > RULES.maximumPickOdds) continue;
    if (modelProb < RULES.minimumModelProbability) continue;
    if (margin < RULES.minimumExpectedRunMargin) continue;
    if (ev < RULES.minimumExpectedValue) continue;

    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(sig.homeEarlyExitsLast3) || 0
      : Number(sig.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(sig.awayEarlyExitsLast3) || 0
      : Number(sig.homeEarlyExitsLast3) || 0;
    const pickEarlyExitsHigher = pickEarly > oppEarly;
    const score = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb, pickEarlyExitsHigher },
      RULES
    );
    const day = hk(row.commenceTime);
    const cand = { day, pickOdds, hit, score, margin, ev, modelProb, band: band(pickOdds) };
    if (!byDayPool.has(day)) byDayPool.set(day, []);
    byDayPool.get(day).push(cand);
  }
}

for (const day of [...byDayPool.keys()].sort()) {
  let slots = [...byDayPool.get(day)].sort((a, b) => b.score - a.score || b.margin - a.margin);
  slots = slots.slice(0, 3);
  if (slots.length >= 3 && slots[2].margin < 0.5) slots = slots.slice(0, 2);
  if (slots.length >= 2 && slots[1].pickOdds >= 1.85 && slots[1].pickOdds < 1.95) {
    slots = [slots[0], ...slots.slice(2)];
  }
  formal.push(...slots);
}

const order = [
  '<1.50',
  '1.50–1.70',
  '1.70–1.85',
  '1.85–1.95（現行可選低段）',
  '1.95–2.10',
  '2.10–2.30',
  '>2.30',
];

const modelByBand = order.map((k) => ({
  band: k,
  ...summarize(modelSideAll.filter((r) => r.band === k)),
  note: k.includes('1.85–1.95') || k.includes('1.95') || k.includes('2.10')
    ? '可能進正式'
    : k.startsWith('<') || k.startsWith('1.5') || k.startsWith('1.7') || k.startsWith('>')
      ? '現行不進正式'
      : '',
}));

const formalByBand = order
  .map((k) => ({ band: k, ...summarize(formal.filter((r) => r.band === k)) }))
  .filter((r) => r.n > 0);

// 若強制把 &lt;1.85 也當「影子選邊」（仍要過 EV/margin/P，只放寬 minOdds）會怎樣？
const shadowLow = [];
for (const r of modelSideAll) {
  if (r.pickOdds >= 1.85) continue;
  if (r.pickOdds < 1.5) continue; // 極端短盤另計
  // 粗略：用 raw prob 估 EV
  const ev = r.modelProbRaw * (r.pickOdds - 1) - (1 - r.modelProbRaw);
  if (r.modelProbRaw < 0.5 || r.margin < 0.25 || ev < 0.02) continue;
  shadowLow.push(r);
}

const below185 = modelSideAll.filter((r) => r.pickOdds < 1.85);
const inBand = modelSideAll.filter((r) => r.pickOdds >= 1.85 && r.pickOdds <= 2.3);

const payload = {
  generatedAt: new Date().toISOString(),
  clarify: {
    weDoNotBetBelow185: true,
    formalMinOdds: 1.85,
    formalMaxOdds: 2.3,
    meaning:
      '漏斗裡「一半以上被擋」= 模型想選的那一邊盤口 &lt;1.85，直接不進推薦；不是選了低賠還進帳。',
  },
  breakevenExamples: [
    { odds: 1.5, needHr: '66.7%' },
    { odds: 1.7, needHr: '58.8%' },
    { odds: 1.85, needHr: '54.1%' },
    { odds: 2.0, needHr: '50.0%' },
    { odds: 2.3, needHr: '43.5%' },
  ],
  modelSideAllBands: modelByBand,
  formalBands: formalByBand,
  compare: {
    modelSide_below185: summarize(below185),
    modelSide_inFormalOddsBand: summarize(inBand),
    shadow_passGates_butOdds_150_to_185: summarize(shadowLow),
    formal_overall: summarize(formal),
    formal_185_195: summarize(formal.filter((r) => r.pickOdds >= 1.85 && r.pickOdds < 1.95)),
  },
};

fs.writeFileSync(
  new URL('../tmp-why-low-odds.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);

console.log('=== 先講清楚 ===');
console.log(payload.clarify.meaning);
console.log('\n打平要多高勝率:', payload.breakevenExamples);

console.log('\n=== 模型選邊後（還沒 Top3）各賠率帶 ===');
for (const r of modelByBand) {
  if (!r.n) continue;
  console.log(
    `${r.band}: n=${r.n} 實勝=${(r.hr * 100).toFixed(1)}% 打平要${(r.needHr * 100).toFixed(1)}% 缺口=${r.gapPp}pp @$50=${r.usd50}`
  );
}

console.log('\n=== 現行正式單（已過門檻+Top3）===');
for (const r of formalByBand) {
  console.log(
    `${r.band}: n=${r.n} 實勝=${(r.hr * 100).toFixed(1)}% 打平要${(r.needHr * 100).toFixed(1)}% @$50=${r.usd50}`
  );
}

console.log('\n=== 對照 ===');
const c = payload.compare;
for (const [k, v] of Object.entries(c)) {
  console.log(
    `${k}: n=${v.n} hr=${v.hr != null ? (v.hr * 100).toFixed(1) + '%' : '-'} need=${v.needHr != null ? (v.needHr * 100).toFixed(1) + '%' : '-'} gap=${v.gapPp}pp $=${v.usd50}`
  );
}
