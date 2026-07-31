/**
 * A+B：空白日主因細拆 + 近失場影子（不改正式規則）
 * 產物：tmp-empty-day-near-miss.json
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
  { key: '2025', from: '2025-04-01', to: '2025-09-30' },
  { key: '2026', from: '2026-04-01', to: '2026-07-28' },
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

function summarize(bets) {
  if (!bets.length) return { n: 0, hr: null, usd50: 0 };
  let hits = 0;
  let unit = 0;
  for (const b of bets) {
    if (b.hit) {
      hits += 1;
      unit += b.pickOdds - 1;
    } else unit -= 1;
  }
  return {
    n: bets.length,
    hr: Number((hits / bets.length).toFixed(4)),
    usd50: Math.round(unit * 50),
  };
}

function selectFormal(pool) {
  const byDay = new Map();
  for (const g of pool) {
    if (!byDay.has(g.day)) byDay.set(g.day, []);
    byDay.get(g.day).push(g);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    let slots = [...byDay.get(day)].sort((a, b) => b.score - a.score || b.margin - a.margin);
    slots = slots.slice(0, 3);
    if (slots.length >= 3 && slots[2].margin < 0.5) slots = slots.slice(0, 2);
    if (slots.length >= 2 && slots[1].pickOdds >= 1.85 && slots[1].pickOdds < 1.95) {
      slots = [slots[0], ...slots.slice(2)];
    }
    out.push(...slots.map((s, i) => ({ ...s, rank: i + 1 })));
  }
  return out;
}

console.log('[A+B] building…');
const validation = getLatestMlbExpectedRunsValidation();
const model = validation.model;

/** @type {Map<string, {day:string, window:string, blocks: Record<string,number>, mlb:number, pool:number}>} */
const dayMeta = new Map();
const formalPool = [];
const nearMissMargin = []; // margin 0.20–0.25, else pass
const nearMissEv = []; // ev 0.01–0.02, else pass
const nearMissOdds175 = []; // odds 1.75–1.85, else would pass other gates

function bumpDay(day, window, key) {
  if (!dayMeta.has(day)) {
    dayMeta.set(day, { day, window, blocks: {}, mlb: 0, pool: 0 });
  }
  const d = dayMeta.get(day);
  d.blocks[key] = (d.blocks[key] || 0) + 1;
}

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
    const day = hk(row.commenceTime);
    if (!dayMeta.has(day)) {
      dayMeta.set(day, { day, window: w.key, blocks: {}, mlb: 0, pool: 0 });
    }
    const dm = dayMeta.get(day);
    dm.mlb += 1;

    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      bumpDay(day, w.key, 'bad_features');
      continue;
    }
    const hs = Number(row.homeScore);
    const as = Number(row.awayScore);
    if (hs === as) {
      bumpDay(day, w.key, 'tie');
      continue;
    }

    const bs = books(row.gameId, row.commenceTime, row.homeTeam, row.awayTeam);
    if (bs.length < 2) {
      bumpDay(day, w.key, 'books_lt_2');
      continue;
    }
    bs.sort((a, b) => a.vig - b.vig);
    const best = bs[0];
    if (best.homeOdds < 1.2 || best.awayOdds < 1.2) {
      bumpDay(day, w.key, 'either_side_short');
      continue;
    }

    const pitchers = features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      bumpDay(day, w.key, 'no_pitcher_id');
      continue;
    }
    const homeWinPct = Number(features?.home?.homeWinPct);
    if (!Number.isFinite(homeWinPct)) {
      bumpDay(day, w.key, 'no_homeWinPct');
      continue;
    }

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
    if (!Number.isFinite(modelProb)) {
      bumpDay(day, w.key, 'no_model_prob');
      continue;
    }

    const pickOdds = pickHome ? best.homeOdds : best.awayOdds;
    const hit = pickHome === hs > as;
    const margin = Math.abs(ph - pa);
    const modelProbShrunk = applyFrozenToxicShrink(modelProb, pickOdds, {
      pickHome,
      homeWinPct,
    });
    const ev = modelProbShrunk * (pickOdds - 1) - (1 - modelProbShrunk);

    // primary block (order mirrors production-ish)
    if (pickOdds < 1.85) {
      bumpDay(day, w.key, 'odds_below_185');
      // near-miss: 1.75–1.85 and would pass other gates
      if (
        pickOdds >= 1.75 &&
        modelProbShrunk >= 0.5 &&
        margin >= 0.25 &&
        ev >= 0.02
      ) {
        nearMissOdds175.push({ day, window: w.key, pickOdds, hit, margin, ev });
      }
      continue;
    }
    if (pickOdds > 2.3) {
      bumpDay(day, w.key, 'odds_above_230');
      continue;
    }
    if (modelProbShrunk < 0.5) {
      bumpDay(day, w.key, 'prob_below_50');
      continue;
    }
    if (margin < 0.25) {
      bumpDay(day, w.key, 'margin_below_025');
      if (margin >= 0.2 && ev >= 0.02) {
        nearMissMargin.push({ day, window: w.key, pickOdds, hit, margin, ev });
      }
      continue;
    }
    if (ev < 0.02) {
      bumpDay(day, w.key, 'ev_below_02');
      if (ev >= 0.01) {
        nearMissEv.push({ day, window: w.key, pickOdds, hit, margin, ev });
      }
      continue;
    }

    const sig = buildPregameRegimeSignals(features);
    const pickEarly = pickHome
      ? Number(sig.homeEarlyExitsLast3) || 0
      : Number(sig.awayEarlyExitsLast3) || 0;
    const oppEarly = pickHome
      ? Number(sig.awayEarlyExitsLast3) || 0
      : Number(sig.homeEarlyExitsLast3) || 0;
    const pickEarlyExitsHigher = pickEarly > oppEarly;
    const score = scoreMlbMoneylineDailyRank(
      {
        expectedValue: ev,
        modelProbability: modelProbShrunk,
        pickEarlyExitsHigher,
      },
      RULES
    );

    dm.pool += 1;
    bumpDay(day, w.key, 'entered_pool');
    formalPool.push({
      day,
      window: w.key,
      pickOdds,
      hit,
      margin,
      ev,
      score,
    });
  }
}

const formal = selectFormal(formalPool);
const baseline = summarize(formal);

// Shadow: add near-misses into pool then re-select (separate variants)
function shadowAdd(extra, label) {
  const merged = [...formalPool, ...extra.map((e) => ({
    ...e,
    score: scoreMlbMoneylineDailyRank(
      { expectedValue: e.ev, modelProbability: 0.52, pickEarlyExitsHigher: false },
      RULES
    ),
  }))];
  // recompute score properly isn't perfect for near-miss; use ev as score proxy
  for (const e of merged) {
    if (e.score == null) e.score = e.ev;
  }
  const picks = selectFormal(merged);
  const s = summarize(picks);
  return {
    label,
    extraN: extra.length,
    ...s,
    deltaN: s.n - baseline.n,
    deltaUsd: s.usd50 - baseline.usd50,
  };
}

const days = [...dayMeta.values()];
const emptyDays = days.filter((d) => (d.blocks.entered_pool || 0) === 0 && d.mlb > 0);
const thinDays = days.filter((d) => (d.blocks.entered_pool || 0) > 0 && (d.blocks.entered_pool || 0) <= 1);
const richDays = days.filter((d) => (d.blocks.entered_pool || 0) >= 3);

function primaryBlockShare(dayList) {
  const totals = {};
  let games = 0;
  for (const d of dayList) {
    for (const [k, v] of Object.entries(d.blocks)) {
      if (k === 'entered_pool' || k === 'tie') continue;
      totals[k] = (totals[k] || 0) + v;
      games += v;
    }
  }
  return Object.entries(totals)
    .map(([k, n]) => ({
      reason: k,
      n,
      pct: games ? Number(((n / games) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.n - a.n);
}

function emptyDayDominantReason(d) {
  const entries = Object.entries(d.blocks).filter(
    ([k]) => k !== 'entered_pool' && k !== 'tie'
  );
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0] ? { reason: entries[0][0], n: entries[0][1] } : null;
}

const emptyDominantDist = {};
for (const d of emptyDays) {
  const dom = emptyDayDominantReason(d);
  if (!dom) continue;
  emptyDominantDist[dom.reason] = (emptyDominantDist[dom.reason] || 0) + 1;
}

const v46Candidates = [
  {
    id: 'probable_starter_contract',
    priority: 'high',
    why: '歷史回測多用賽後先發，實盤是預定先發；縮 live／回測落差最可能同時改善命中與場次品質',
  },
  {
    id: 'opener_bullpen_game_flag',
    priority: 'medium',
    why: 'regime／高总分弱點；標記 opener／牛棚賽可減少錯邊',
  },
  {
    id: 'clv_opening_vs_recommend_time',
    priority: 'medium',
    why: '不直接加場，但能量化執行品質；篩掉長期負 CLV 的時段',
  },
  {
    id: 'weather_park_reentry',
    priority: 'low',
    why: '已回填，入模增益極小；低優先',
  },
  {
    id: 'do_not_relax_minodds_margin_ev',
    priority: 'blocked',
    why: '近失場影子若顯示加場傷錢，則確認勿放寬門檻',
  },
];

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'diagnose_shadow_only',
  baselineFormal: baseline,
  emptyDays: {
    n: emptyDays.length,
    pctOfDays: Number(((emptyDays.length / days.length) * 100).toFixed(1)),
    dominantReasonByDay: emptyDominantDist,
    blockShareOnEmptyDays: primaryBlockShare(emptyDays),
    sample: emptyDays.slice(0, 10).map((d) => ({
      day: d.day,
      mlb: d.mlb,
      dominant: emptyDayDominantReason(d),
      blocks: d.blocks,
    })),
  },
  thinVsRich: {
    thinPoolLe1: {
      n: thinDays.length,
      blockShare: primaryBlockShare(thinDays),
    },
    richPoolGe3: {
      n: richDays.length,
      blockShare: primaryBlockShare(richDays),
    },
  },
  nearMissShadow: {
    note: '把近失場加進池再跑 Top3；非正式建議',
    margin_020_025: {
      raw: summarize(nearMissMargin),
      ifAddedToPool: shadowAdd(nearMissMargin, 'margin_near'),
    },
    ev_01_02: {
      raw: summarize(nearMissEv),
      ifAddedToPool: shadowAdd(nearMissEv, 'ev_near'),
    },
    odds_175_185_else_pass: {
      raw: summarize(nearMissOdds175),
      ifAddedToPool: shadowAdd(nearMissOdds175, 'odds_near'),
    },
  },
  v46FeatureCandidates: v46Candidates,
  verdictPlain: {
    emptyDays:
      '空白日幾乎都是當天合格池=0；主因仍是短盤（模型選邊<1.85），不是 Top3 砍光。',
    nearMiss:
      '若影子顯示加近失場 Δ$ 為負或不穩 → 不要放寬 margin/EV/1.85；應走模型特徵。',
    next:
      '正式常數凍結；產品層做同日2串提示；模型側下一步做 probable starter 契約／影子。',
  },
};

fs.writeFileSync(
  new URL('../tmp-empty-day-near-miss.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);

console.log('empty days', payload.emptyDays.n, payload.emptyDays.dominantReasonByDay);
console.log('empty block share', payload.emptyDays.blockShareOnEmptyDays.slice(0, 5));
console.log('baseline', baseline);
console.log('near margin raw', payload.nearMissShadow.margin_020_025.raw, 'add', payload.nearMissShadow.margin_020_025.ifAddedToPool);
console.log('near ev raw', payload.nearMissShadow.ev_01_02.raw, 'add', payload.nearMissShadow.ev_01_02.ifAddedToPool);
console.log('near odds raw', payload.nearMissShadow.odds_175_185_else_pass.raw, 'add', payload.nearMissShadow.odds_175_185_else_pass.ifAddedToPool);
console.log('wrote tmp-empty-day-near-miss.json');
