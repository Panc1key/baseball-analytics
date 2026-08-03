/**
 * 診斷：賠率「高於上限」(>2.30) 是否也像過低下限一樣偏虧？
 *
 * 對照鎖定 B：maxOdds≤2.30
 * 變體：把 maxOdds 放到 2.50 / 2.80 / 3.20，看多進來的長賠單 @$50
 *
 * 用法: node scripts/auditMlbMaxOddsUpperBandDiag.mjs
 * 產物: tmp-max-odds-upper-band-diag.json
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
} from '../src/services/MlbExpectedRunsModel.js';
import {
  applyFrozenResidualToPrediction,
  applyFrozenToxicShrink,
  MLB_FROZEN_B_SHADOW_SPEC,
} from '../src/services/MlbFrozenBShadow.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '../tmp-max-odds-upper-band-diag.json');

const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

const BASE_B = {
  ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230,
  minimumH2hBookmakers: MLB_FROZEN_B_SHADOW_SPEC.selection.minimumH2hBookmakers,
};
const DROP_R3 = MLB_FROZEN_B_SHADOW_SPEC.selection.dropThirdIfMarginBelow;
const DROP_R2_MAX = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsBelow;
const DROP_R2_MIN = MLB_FROZEN_B_SHADOW_SPEC.selection.dropSecondIfOddsMin;
const STAKE = 50;
const MAX_CAPS = [2.3, 2.5, 2.8, 3.2];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function finite(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0, usd50PerBet: null };
  }
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
    usd50PerBet: Number(((unit * STAKE) / n).toFixed(2)),
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

function selectLockedB(pool, { maxOdds = 2.3 } = {}) {
  const rules = { ...BASE_B, maximumPickOdds: maxOdds };
  const byDay = new Map();
  for (const g of pool) {
    const pred = g.lockedPred;
    const ph = pred.homeExpectedRuns;
    const pa = pred.awayExpectedRuns;
    const pickHome = ph >= pa;
    let modelProb = pickHome
      ? +pred.markets.homeWinProbability
      : +pred.markets.awayWinProbability;
    const pickOdds = pickHome ? g.homeOdds : g.awayOdds;
    if (pickOdds < 1.4 || pickOdds > maxOdds + 0.0001) continue;
    if ((pickHome ? g.homeEarly : g.awayEarly) > (pickHome ? g.awayEarly : g.homeEarly)) {
      continue;
    }
    modelProb = applyFrozenToxicShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct: g.homeWinPct,
    });
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    if (ev < rules.minimumExpectedValue) continue;
    if (margin < rules.minimumExpectedRunMargin) continue;
    if (modelProb < rules.minimumModelProbability) continue;
    if (pickOdds < rules.minimumPickOdds || pickOdds > rules.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      rules
    );
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push({
      gameId: g.gameId,
      day: g.day,
      window: g.window,
      pickHome,
      pickOdds,
      modelProb,
      ev,
      margin,
      bScore,
      hit: pickHome ? g.homeWon : !g.homeWon,
      aboveFormalMax: pickOdds > 2.3,
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

function pack(bets, baselineByWindow = null) {
  const byWindow = {};
  for (const w of WINDOWS) {
    const s = summarize(bets.filter((b) => b.window === w.key));
    byWindow[w.key] = baselineByWindow
      ? {
          ...s,
          deltaUsd: s.usd50 - (baselineByWindow[w.key]?.usd50 ?? 0),
        }
      : s;
  }
  const overall = summarize(bets);
  return {
    overall: baselineByWindow
      ? {
          ...overall,
          deltaUsd: overall.usd50 - (baselineByWindow.__merged?.usd50 ?? 0),
        }
      : overall,
    byWindow,
    longshotsOnly: summarize(bets.filter((b) => b.aboveFormalMax)),
  };
}

const validation = getLatestMlbExpectedRunsValidation();
const model = validation?.model;
if (!model) throw new Error('missing_formal_v45_model');

const pool = [];
for (const w of WINDOWS) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam, g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1 AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
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
    features.gameId = row.gameId;
    features.commenceTime = row.commenceTime;
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    const homeWinPct = finite(features?.home?.homeWinPct);
    if (homeWinPct == null) continue;

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

    const basePred = predictMlbGameRuns(model, features, { totalLine: 8.5 });
    const lockedPred = applyFrozenResidualToPrediction(
      model,
      basePred,
      homeWinPct - 0.5
    );
    const sig = buildPregameRegimeSignals(features);
    pool.push({
      gameId: row.gameId,
      window: w.key,
      day: hk(row.commenceTime),
      homeWon: hs > as,
      homeWinPct,
      homeOdds: best.homeOdds,
      awayOdds: best.awayOdds,
      homeEarly: +sig.homeEarlyExitsLast3 || 0,
      awayEarly: +sig.awayEarlyExitsLast3 || 0,
      lockedPred,
    });
  }
}

const baselineBets = selectLockedB(pool, { maxOdds: 2.3 });
const baselineByWindow = {
  __merged: summarize(baselineBets),
};
for (const w of WINDOWS) {
  baselineByWindow[w.key] = summarize(baselineBets.filter((b) => b.window === w.key));
}

const byMaxCap = {};
for (const cap of MAX_CAPS) {
  const bets = selectLockedB(pool, { maxOdds: cap });
  byMaxCap[`maxOdds_${cap}`] = {
    maxOdds: cap,
    ...pack(bets, baselineByWindow),
    incrementalVs230: summarize(bets.filter((b) => b.aboveFormalMax)),
  };
}

// 只看「若放寬到 3.20，最終入選且賠率落在各長賠帶」的表現
const wide = selectLockedB(pool, { maxOdds: 3.2 });
const bands = [
  { key: '1.85-2.00', lo: 1.85, hi: 2.0 },
  { key: '2.00-2.15', lo: 2.0, hi: 2.15 },
  { key: '2.15-2.30', lo: 2.15, hi: 2.3 },
  { key: '2.30-2.50', lo: 2.3, hi: 2.5 },
  { key: '2.50-2.80', lo: 2.5, hi: 2.8 },
  { key: '2.80-3.20', lo: 2.8, hi: 3.2 },
];
const byOddsBandIfMax320 = {};
for (const band of bands) {
  byOddsBandIfMax320[band.key] = summarize(
    wide.filter((b) => b.pickOdds >= band.lo && b.pickOdds < band.hi)
  );
}

const addedAt250 = byMaxCap['maxOdds_2.5'].incrementalVs230;
const addedAt280 = byMaxCap['maxOdds_2.8'].incrementalVs230;
const addedAt320 = byMaxCap['maxOdds_3.2'].incrementalVs230;

function interpret() {
  const long = [
    { label: '2.30-2.50 增量', s: byOddsBandIfMax320['2.30-2.50'] },
    { label: '2.50-2.80 增量', s: byOddsBandIfMax320['2.50-2.80'] },
    { label: '2.80-3.20 增量', s: byOddsBandIfMax320['2.80-3.20'] },
  ];
  const weakLong = long.filter(
    (x) =>
      x.s.bets >= 15 &&
      ((x.s.usd50PerBet != null && x.s.usd50PerBet < 0) ||
        (x.s.hitRate != null && x.s.hitRate < 0.48))
  );
  const raiseHurts =
    (byMaxCap['maxOdds_2.5'].overall.deltaUsd ?? 0) < 0 &&
    (byMaxCap['maxOdds_2.8'].overall.deltaUsd ?? 0) < 0;

  let verdict;
  if (weakLong.length >= 2 || (addedAt320.bets >= 20 && (addedAt320.usd50 ?? 0) < 0)) {
    verdict =
      '高於 2.30 的長賠帶整體偏弱／虧錢：上限有防護作用，不宜放寬。';
  } else if (raiseHurts) {
    verdict =
      '放寬 maxOdds 後合併紙上變差：過高賠率帶會拖累，維持 ≤2.30 合理。';
  } else if (
    addedAt320.bets >= 15 &&
    (addedAt320.usd50PerBet ?? 0) > 5 &&
    byMaxCap['maxOdds_3.2'].byWindow['2024']?.deltaUsd >= 0 &&
    byMaxCap['maxOdds_3.2'].byWindow['2025'].deltaUsd >= 0 &&
    byMaxCap['maxOdds_3.2'].byWindow['2026'].deltaUsd >= 0
  ) {
    verdict =
      '長賠增量意外不差且三窗不傷；可另開影子討論，但仍非立刻改正式上限。';
  } else {
    verdict =
      '長賠樣本或結果不乾淨；預設維持正式上限 2.30，不建議為單場觀察級放寬。';
  }
  return { verdict, weakLongLabels: weakLong.map((x) => x.label), raiseHurts };
}

const interpretation = interpret();

const report = {
  generatedAt: new Date().toISOString(),
  modelVersion: validation.modelVersion,
  note:
    '只診斷。基線=鎖定B maxOdds≤2.30；變體僅改 maximumPickOdds。增量=放寬後入選且 pickOdds>2.30 的單。',
  baseline: {
    overall: baselineByWindow.__merged,
    byWindow: {
      '2024': baselineByWindow['2024'],
      '2025': baselineByWindow['2025'],
      '2026': baselineByWindow['2026'],
    },
  },
  byMaxCap,
  byOddsBandIfMax320,
  interpretation,
};

fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log('=== Max-odds upper band diagnostic (2024+2025+2026) ===');
console.log('baseline max≤2.30', baselineByWindow.__merged);
for (const cap of MAX_CAPS) {
  const r = byMaxCap[`maxOdds_${cap}`];
  console.log(`max≤${cap}`, {
    overall: r.overall,
    longshotIncremental: r.incrementalVs230,
    y24: r.byWindow['2024'],
    y25: r.byWindow['2025'],
    y26: r.byWindow['2026'],
  });
}
console.log('bands @ max3.20', byOddsBandIfMax320);
console.log('VERDICT:', interpretation.verdict);
console.log('wrote', outPath);
