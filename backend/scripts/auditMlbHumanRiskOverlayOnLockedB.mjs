/**
 * 人腦風險層 vs 鎖定 B（不改 B 常數）
 * 問題：主場偏好／少選客場 這類分析，疊在 B 選注上能否抬勝率、$？
 *
 * 產物：tmp-human-risk-overlay-on-locked-b.json
 * 用法: node scripts/auditMlbHumanRiskOverlayOnLockedB.mjs
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
  if (!bets.length) {
    return { bets: 0, hitRate: null, avgOdds: null, roi: null, usd50: 0, breakeven: null };
  }
  let unit = 0;
  let odds = 0;
  let hits = 0;
  for (const b of bets) {
    odds += b.pickOdds;
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  const n = bets.length;
  const avg = odds / n;
  return {
    bets: n,
    hitRate: Number((hits / n).toFixed(4)),
    avgOdds: Number(avg.toFixed(3)),
    breakeven: Number((1 / avg).toFixed(4)),
    roi: Number((unit / n).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function build(from, to) {
  const validation = getLatestMlbExpectedRunsValidation();
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
  const pool = [];
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
    const modelProb = pickHome
      ? +pred.markets?.homeWinProbability
      : +pred.markets?.awayWinProbability;
    if (!Number.isFinite(modelProb)) continue;
    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) continue;
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(ph - pa);
    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? +sig.homeEarlyExitsLast3 || 0
      : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome
      ? +sig.awayEarlyExitsLast3 || 0
      : +sig.homeEarlyExitsLast3 || 0;
    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2 || pickEarly > oppEarly) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    pool.push({
      gameId: row.gameId,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      window: from.startsWith('2025') ? '2025' : '2026',
      hit: pickHome === hs > as,
      pickHome,
      pickOdds,
      ev,
      margin,
      modelProb,
      bScore,
      homeWinPct: +features?.home?.homeWinPct || null,
      homeSeasonWinPct: +features?.home?.seasonWinPct || null,
      awaySeasonWinPct: +features?.away?.seasonWinPct || null,
      homeLast10: +features?.home?.last10WinPct || null,
      awayLast10: +features?.away?.last10WinPct || null,
    });
  }
  return pool;
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

function selectB(pool) {
  const map = new Map();
  for (const g of pool) {
    if (
      g.ev < B.minimumExpectedValue ||
      g.margin < B.minimumExpectedRunMargin ||
      g.modelProb < B.minimumModelProbability ||
      g.pickOdds < B.minimumPickOdds ||
      g.pickOdds > B.maximumPickOdds
    ) {
      continue;
    }
    if (!map.has(g.day)) map.set(g.day, []);
    map.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...map.keys()].sort()) {
    const arr = [...map.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    out.push(...applyDrop(arr));
  }
  return out;
}

/** 人腦風險層：只過濾 B 已選中的場，不改定邊／不改 B 常數 */
const OVERLAYS = [
  {
    id: 'baseline_locked_b',
    label: '純鎖定 B（對照）',
    keep: () => true,
  },
  {
    id: 'home_only',
    label: '只保留主場選邊（禁客）',
    keep: (g) => g.pickHome === true,
  },
  {
    id: 'away_only',
    label: '只保留客場選邊（對照用）',
    keep: (g) => g.pickHome === false,
  },
  {
    id: 'no_away_vs_strong_home',
    label: '禁：客勝且主隊主場勝率≥65%',
    keep: (g) => !(g.pickHome === false && (g.homeWinPct ?? 0) >= 0.65),
  },
  {
    id: 'no_away_vs_strong_home_60',
    label: '禁：客勝且主隊主場勝率≥60%',
    keep: (g) => !(g.pickHome === false && (g.homeWinPct ?? 0) >= 0.6),
  },
  {
    id: 'no_away_dog',
    label: '禁：客場且賠率≥2.00（客隊冷門）',
    keep: (g) => !(g.pickHome === false && g.pickOdds >= 2.0),
  },
  {
    id: 'away_needs_margin_075',
    label: '客場必須 margin≥0.75，否則丟掉',
    keep: (g) => g.pickHome === true || g.margin >= 0.75,
  },
  {
    id: 'away_needs_margin_100',
    label: '客場必須 margin≥1.0，否則丟掉',
    keep: (g) => g.pickHome === true || g.margin >= 1.0,
  },
  {
    id: 'no_thin_away',
    label: '禁：客場且 P<55%（薄邊客）',
    keep: (g) => !(g.pickHome === false && g.modelProb < 0.55),
  },
];

console.log('Building locked B picks…');
const allPicks = WINDOWS.flatMap((w) => selectB(build(w.from, w.to)));
const base = summarize(allPicks);
const homePicks = allPicks.filter((g) => g.pickHome);
const awayPicks = allPicks.filter((g) => !g.pickHome);

const results = OVERLAYS.map((o) => {
  const kept = allPicks.filter(o.keep);
  const dropped = allPicks.filter((g) => !o.keep(g));
  const s = summarize(kept);
  const d = summarize(dropped);
  return {
    id: o.id,
    label: o.label,
    kept: s,
    dropped: d,
    deltaHitRatePp:
      s.hitRate != null && base.hitRate != null
        ? Number(((s.hitRate - base.hitRate) * 100).toFixed(2))
        : null,
    deltaUsd50: s.usd50 - base.usd50,
    keepRate: Number((kept.length / allPicks.length).toFixed(3)),
    byWindow: {
      '2025': summarize(kept.filter((g) => g.window === '2025')),
      '2026': summarize(kept.filter((g) => g.window === '2026')),
    },
  };
});

results.sort((a, b) => (b.kept.usd50 ?? -9999) - (a.kept.usd50 ?? -9999));

const out = {
  experimentId: 'human-risk-overlay-on-locked-b-2026-07-29',
  note: '不改 B 常數；只測人腦風險層能否抬勝率/$',
  lockedB: base,
  split: {
    homePicks: summarize(homePicks),
    awayPicks: summarize(awayPicks),
    homeShare: Number((homePicks.length / allPicks.length).toFixed(3)),
    awayShare: Number((awayPicks.length / allPicks.length).toFixed(3)),
  },
  overlays: results,
  readingGuide: [
    '若 home_only 勝率明顯↑但 $↓：砍掉的客場其實在賺錢（長賠），體感準但總利下降',
    '若 home_only 勝率↑且 $≥B：人腦主場偏好可作獨立過濾候選',
    'Yankees@Dodgers 類：薄邊客勝 → 看 no_thin_away / no_away_dog / no_away_vs_strong_home',
  ],
};

fs.writeFileSync(
  new URL('../tmp-human-risk-overlay-on-locked-b.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('鎖定B', base);
console.log('主場選邊', out.split.homePicks);
console.log('客場選邊', out.split.awayPicks);
console.log('\n疊加層（相對純B）:');
for (const r of results) {
  console.log(
    `${r.id.padEnd(28)} keep=${String(r.kept.bets).padStart(3)} hr=${r.kept.hitRate} Δhr=${r.deltaHitRatePp}pp $=${r.kept.usd50} Δ$=${r.deltaUsd50} dropN=${r.dropped.bets} dropHR=${r.dropped.hitRate} drop$=${r.dropped.usd50}`
  );
}
