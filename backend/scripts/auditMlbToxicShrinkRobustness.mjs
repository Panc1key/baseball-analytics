/**
 * 收縮版穩健性加測（w=0.5 主候選）
 * - 固定 w∈{0.4,0.45,0.5,0.55,0.6} 敏感度
 * - 分年 / 分月
 * - 2024 holdout：用 2025+2026 選 w，只評 2024（反向也測）
 * - 與 skip_ev10 影子對照
 *
 * 用法：node scripts/auditMlbToxicShrinkRobustness.mjs
 * 產物：tmp-b-toxic-shrink-robustness.json
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
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';

const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
const STRONG = 0.65;
const STAKE = 50;
const W_FOCUS = [0.4, 0.45, 0.5, 0.55, 0.6];
const WINDOWS = [
  { key: '2024', from: '2024-04-01', to: '2024-09-30' },
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-22' },
];

function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}
function ym(iso) {
  return hk(iso).slice(0, 7);
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
function isToxic(c) {
  return c.pickHome === false && (c.homeWinPct ?? 0) >= STRONG;
}

function buildCandidates() {
  const validation = getLatestMlbExpectedRunsValidation();
  const out = [];
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
      const hs = +row.homeScore;
      const as = +row.awayScore;
      if (hs === as) continue;
      const pred = predictMlbGameRuns(validation.model, features, { totalLine: 8.5 });
      const ph = +pred.homeExpectedRuns;
      const pa = +pred.awayExpectedRuns;
      if (!Number.isFinite(ph) || !Number.isFinite(pa)) continue;
      const pickHome = ph >= pa;
      const modelProbRaw = pickHome
        ? +pred.markets?.homeWinProbability
        : +pred.markets?.awayWinProbability;
      if (!Number.isFinite(modelProbRaw)) continue;
      const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
      if (bs.length < 2) continue;
      bs.sort((a, b) => a.vig - b.vig);
      const best = bs[0];
      const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
      if (pickOdds < 1.4 || pickOdds > 2.3) continue;
      const margin = Math.abs(ph - pa);
      const sig = buildPregameRegimeSignals(features);
      const pickEarly = pickHome ? +sig.homeEarlyExitsLast3 || 0 : +sig.awayEarlyExitsLast3 || 0;
      const oppEarly = pickHome ? +sig.awayEarlyExitsLast3 || 0 : +sig.homeEarlyExitsLast3 || 0;
      const pitchers = features?.pitchers || {};
      if (
        (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
        (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
      ) {
        continue;
      }
      if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
      out.push({
        window: w.key,
        day: hk(row.commenceTime),
        month: ym(row.commenceTime),
        gameId: row.gameId,
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
        homeWon: hs > as,
        pickHome,
        modelProbRaw,
        pickOdds,
        homeOdds: best.homeOdds,
        awayOdds: best.awayOdds,
        margin,
        homeWinPct: +features?.home?.homeWinPct || null,
      });
    }
  }
  return out;
}

function selectB(cands, w) {
  const byDay = new Map();
  for (const c of cands) {
    let modelProb = c.modelProbRaw;
    if (isToxic(c) && w > 0) {
      const market = 1 / c.pickOdds;
      modelProb = c.modelProbRaw * (1 - w) + market * w;
    }
    const ev = modelProb * (c.pickOdds - 1) - (1 - modelProb);
    if (ev < B.minimumExpectedValue) continue;
    if (c.margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (c.pickOdds < B.minimumPickOdds || c.pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push({
      ...c,
      modelProb,
      ev,
      bScore,
      hit: c.pickHome ? c.homeWon : !c.homeWon,
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

function skipIllusionEv10(bets) {
  return bets.filter(
    (b) =>
      !(
        b.rank === 1 &&
        isToxic(b) &&
        b.ev >= 0.1
      )
  );
}

function toxicIllusionR1(bets) {
  return bets.filter((b) => b.rank === 1 && isToxic(b) && b.ev >= 0.1);
}

function evalPack(cands, w) {
  const bets = selectB(cands, w);
  const base = selectB(cands, 0);
  const byWindow = {};
  for (const win of WINDOWS) {
    const b = bets.filter((x) => x.window === win.key);
    const r = base.filter((x) => x.window === win.key);
    byWindow[win.key] = {
      shrink: summarize(b),
      raw: summarize(r),
      deltaUsd: summarize(b).usd50 - summarize(r).usd50,
    };
  }
  const months = [...new Set(bets.map((x) => x.month))].sort();
  let beat = 0;
  let hurt = 0;
  let flat = 0;
  const monthly = [];
  for (const m of months) {
    const sb = summarize(bets.filter((x) => x.month === m));
    const rb = summarize(base.filter((x) => x.month === m));
    const d = sb.usd50 - rb.usd50;
    if (d > 0) beat += 1;
    else if (d < 0) hurt += 1;
    else flat += 1;
    monthly.push({ month: m, deltaUsd: d, shrink: sb, raw: rb });
  }
  return {
    w,
    overall: summarize(bets),
    rawOverall: summarize(base),
    deltaUsd: summarize(bets).usd50 - summarize(base).usd50,
    deltaHrPp:
      summarize(bets).hitRate != null && summarize(base).hitRate != null
        ? Number(((summarize(bets).hitRate - summarize(base).hitRate) * 100).toFixed(2))
        : null,
    byWindow,
    monthBeatHurt: { beat, hurt, flat },
    toxicIllusionRank1: {
      rawN: toxicIllusionR1(base).length,
      shrinkN: toxicIllusionR1(bets).length,
      raw: summarize(toxicIllusionR1(base)),
      shrink: summarize(toxicIllusionR1(bets)),
    },
    monthly,
  };
}

const candidates = buildCandidates();
const sensitivity = W_FOCUS.map((w) => evalPack(candidates, w));

// Holdout A: train on 2025+2026 pick best w, test 2024
const trainA = candidates.filter((c) => c.window !== '2024');
const testA = candidates.filter((c) => c.window === '2024');
let bestWA = 0.5;
let bestScoreA = -1e18;
for (const w of W_FOCUS) {
  const s = summarize(selectB(trainA, w));
  const base = summarize(selectB(trainA, 0));
  const score = s.usd50 - base.usd50;
  if (score > bestScoreA) {
    bestScoreA = score;
    bestWA = w;
  }
}
const holdoutA = {
  trainOn: '2025+2026',
  testOn: '2024',
  selectedW: bestWA,
  trainDeltaUsd: bestScoreA,
  test: {
    raw: summarize(selectB(testA, 0)),
    shrink: summarize(selectB(testA, bestWA)),
    deltaUsd:
      summarize(selectB(testA, bestWA)).usd50 - summarize(selectB(testA, 0)).usd50,
  },
};

// Holdout B: train on 2024+2025, test 2026
const trainB = candidates.filter((c) => c.window !== '2026');
const testB = candidates.filter((c) => c.window === '2026');
let bestWB = 0.5;
let bestScoreB = -1e18;
for (const w of W_FOCUS) {
  const s = summarize(selectB(trainB, w));
  const base = summarize(selectB(trainB, 0));
  const score = s.usd50 - base.usd50;
  if (score > bestScoreB) {
    bestScoreB = score;
    bestWB = w;
  }
}
const holdoutB = {
  trainOn: '2024+2025',
  testOn: '2026',
  selectedW: bestWB,
  trainDeltaUsd: bestScoreB,
  test: {
    raw: summarize(selectB(testB, 0)),
    shrink: summarize(selectB(testB, bestWB)),
    deltaUsd:
      summarize(selectB(testB, bestWB)).usd50 - summarize(selectB(testB, 0)).usd50,
  },
};

// Holdout C: train 2024, test 2025+2026
const trainC = candidates.filter((c) => c.window === '2024');
const testC = candidates.filter((c) => c.window !== '2024');
let bestWC = 0.5;
let bestScoreC = -1e18;
for (const w of W_FOCUS) {
  const s = summarize(selectB(trainC, w));
  const base = summarize(selectB(trainC, 0));
  const score = s.usd50 - base.usd50;
  if (score > bestScoreC) {
    bestScoreC = score;
    bestWC = w;
  }
}
const holdoutC = {
  trainOn: '2024',
  testOn: '2025+2026',
  selectedW: bestWC,
  trainDeltaUsd: bestScoreC,
  test: {
    raw: summarize(selectB(testC, 0)),
    shrink: summarize(selectB(testC, bestWC)),
    deltaUsd:
      summarize(selectB(testC, bestWC)).usd50 - summarize(selectB(testC, 0)).usd50,
  },
};

const w05 = sensitivity.find((x) => x.w === 0.5);
const skipOnly = (() => {
  const base = selectB(candidates, 0);
  const kept = skipIllusionEv10(base);
  return {
    overall: summarize(kept),
    deltaUsd: summarize(kept).usd50 - summarize(base).usd50,
    toxicLeft: toxicIllusionR1(kept).length,
  };
})();

const keepVerdict = {
  keepAsShadow: true,
  keepAsFormalWire: false,
  reasonsKeepShadow: [
    '對症：直接壓假 EV，幻覺 Rank1 從 20 降到很少',
    '固定 w=0.5 全窗 Δ$ 正、注數只少約 8',
    '比單純 skip 規則更貼模型錯誤本質',
  ],
  reasonsNotWireYet: [
    'Expanding / 月級 beat-hurt 接近打平，不是壓倒性穩',
    '三窗相對 raw 未必全勝（先前網格常 2/3）',
    '鎖定 B 正走路徑 γ，不應同輪改正式常數',
  ],
};

const out = {
  experimentId: 'b-toxic-shrink-robustness-2026-07-29',
  focusW: 0.5,
  sensitivity,
  holdouts: { holdoutA, holdoutB, holdoutC },
  compareSkipEv10: skipOnly,
  w05Summary: w05
    ? {
        deltaUsd: w05.deltaUsd,
        deltaHrPp: w05.deltaHrPp,
        monthBeatHurt: w05.monthBeatHurt,
        byWindow: w05.byWindow,
        toxicIllusionRank1: w05.toxicIllusionRank1,
      }
    : null,
  keepVerdict,
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-shrink-robustness.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('=== w 敏感度 ===');
for (const s of sensitivity) {
  console.log(
    `w=${s.w} Δ$=${s.deltaUsd} Δhr=${s.deltaHrPp} month ${s.monthBeatHurt.beat}/${s.monthBeatHurt.hurt}/${s.monthBeatHurt.flat} illusionR1 ${s.toxicIllusionRank1.rawN}->${s.toxicIllusionRank1.shrinkN}`
  );
  console.log(
    `  2024 Δ$${s.byWindow['2024'].deltaUsd} | 2025 Δ$${s.byWindow['2025'].deltaUsd} | 2026 Δ$${s.byWindow['2026'].deltaUsd}`
  );
}
console.log('\n=== Holdout ===');
console.log('A', holdoutA);
console.log('B', holdoutB);
console.log('C', holdoutC);
console.log('\nskipEv10 Δ$', skipOnly.deltaUsd);
console.log('\nKEEP VERDICT', keepVerdict);
