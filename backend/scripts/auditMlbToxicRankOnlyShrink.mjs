/**
 * 排名專用收縮（不踢出池）
 *
 * 對照：
 * A) full：毒+P>=thr 用 P' 同時過閘+排名（現行影子）
 * B) rank_only：過閘仍用 raw P；僅日內排序用 P'（降權但不踢出）
 * C) rank_only_r1_cap：同 B，且若排序後 Rank1 仍是毒高P客勝，強制與第2名交換／降到第2
 *
 * 用法：node scripts/auditMlbToxicRankOnlyShrink.mjs
 * 產物：tmp-b-toxic-rank-only-shrink.json
 *       若更優則更新 tmp-b-toxic-conditional-shrink-shadow.json
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
const WARMUP = 3;
const THR = 0.55;
const W = 0.45;

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
function shouldShrink(c) {
  return isToxic(c) && c.modelProbRaw >= THR;
}
function shrinkP(c) {
  const market = 1 / c.pickOdds;
  return c.modelProbRaw * (1 - W) + market * W;
}
function keyOf(b) {
  return `${b.day}|${b.gameId}|${b.pickHome ? 'H' : 'A'}`;
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

function selectRaw(cands) {
  return selectMode(cands, 'raw');
}

function selectMode(cands, mode) {
  // mode: raw | full | rank_only | rank_only_demote_r1
  const byDay = new Map();
  for (const c of cands) {
    const rawP = c.modelProbRaw;
    const rawEv = rawP * (c.pickOdds - 1) - (1 - rawP);
    const pShrink = shouldShrink(c) ? shrinkP(c) : rawP;
    const evShrink = pShrink * (c.pickOdds - 1) - (1 - pShrink);

    let gateP = rawP;
    let gateEv = rawEv;
    let rankP = rawP;
    let rankEv = rawEv;

    if (mode === 'full' && shouldShrink(c)) {
      gateP = pShrink;
      gateEv = evShrink;
      rankP = pShrink;
      rankEv = evShrink;
    } else if (
      (mode === 'rank_only' || mode === 'rank_only_demote_r1') &&
      shouldShrink(c)
    ) {
      rankP = pShrink;
      rankEv = evShrink;
      // gates stay raw
    }

    if (gateEv < B.minimumExpectedValue) continue;
    if (c.margin < B.minimumExpectedRunMargin) continue;
    if (gateP < B.minimumModelProbability) continue;
    if (c.pickOdds < B.minimumPickOdds || c.pickOdds > B.maximumPickOdds) continue;

    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: rankEv, modelProbability: rankP },
      B
    );
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push({
      ...c,
      modelProb: gateP,
      ev: gateEv,
      rankP,
      rankEv,
      bScore,
      hit: c.pickHome ? c.homeWon : !c.homeWon,
      toxicHighP: shouldShrink(c),
    });
  }

  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    let arr = [...byDay.get(day)].sort(
      (a, b) => b.bScore - a.bScore || b.margin - a.margin
    );
    let slots = applyDrop(arr);

    if (mode === 'rank_only_demote_r1' && slots.length >= 2) {
      if (slots[0].toxicHighP) {
        // 把毒高P客勝從 Rank1 降到第2（與第2交換）
        const tmp = slots[0];
        slots[0] = slots[1];
        slots[1] = tmp;
      }
    }

    slots.forEach((x, i) => out.push({ ...x, rank: i + 1 }));
  }
  return out;
}

function falseKickHits(rawBets, optBets) {
  const optKeys = new Set(optBets.map(keyOf));
  let n = 0;
  let usd = 0;
  for (const b of rawBets) {
    if (!optKeys.has(keyOf(b)) && b.hit) {
      n += 1;
      usd += Math.round((b.pickOdds - 1) * STAKE);
    }
  }
  return { n, usd };
}

function evalMode(cands, mode, rawAll) {
  const bets = selectMode(cands, mode);
  const s = summarize(bets);
  const rawSum = summarize(rawAll);
  const byWindow = {};
  let winNonNeg = 0;
  for (const win of WINDOWS) {
    const bs = summarize(bets.filter((x) => x.window === win.key));
    const rs = summarize(rawAll.filter((x) => x.window === win.key));
    byWindow[win.key] = { ...bs, deltaUsd: bs.usd50 - rs.usd50 };
    if (bs.usd50 - rs.usd50 >= 0) winNonNeg += 1;
  }

  const months = [...new Set(cands.map((c) => c.month))].sort().slice(WARMUP);
  let beat = 0;
  let hurt = 0;
  let flat = 0;
  let sumDelta = 0;
  for (const m of months) {
    const rawM = selectMode(
      cands.filter((c) => c.month === m),
      'raw'
    );
    const optM = selectMode(
      cands.filter((c) => c.month === m),
      mode
    );
    const d = summarize(optM).usd50 - summarize(rawM).usd50;
    sumDelta += d;
    if (d > 0) beat += 1;
    else if (d < 0) hurt += 1;
    else flat += 1;
  }

  return {
    mode,
    kept: s,
    deltaUsd: s.usd50 - rawSum.usd50,
    deltaHrPp:
      s.hitRate != null && rawSum.hitRate != null
        ? Number(((s.hitRate - rawSum.hitRate) * 100).toFixed(2))
        : null,
    byWindow,
    windowsNonNeg: winNonNeg,
    oosMonth: { beat, hurt, flat, sumDeltaUsd: sumDelta },
    falseKickHits: falseKickHits(rawAll, bets),
    toxicRank1Count: bets.filter((b) => b.rank === 1 && b.toxicHighP).length,
  };
}

const candidates = buildCandidates();
const rawAll = selectMode(candidates, 'raw');
const modes = ['raw', 'full', 'rank_only', 'rank_only_demote_r1'];
const results = modes.map((m) => evalMode(candidates, m, rawAll));
results.sort((a, b) => {
  if (a.mode === 'raw') return 1;
  if (b.mode === 'raw') return -1;
  return (
    b.windowsNonNeg - a.windowsNonNeg ||
    b.oosMonth.beat - b.oosMonth.hurt - (a.oosMonth.beat - a.oosMonth.hurt) ||
    b.deltaUsd - a.deltaUsd
  );
});

const full = results.find((r) => r.mode === 'full');
const bestNonRaw = results.find((r) => r.mode !== 'raw');
const improved =
  bestNonRaw &&
  full &&
  (bestNonRaw.oosMonth.hurt < full.oosMonth.hurt ||
    bestNonRaw.falseKickHits.n < full.falseKickHits.n ||
    (bestNonRaw.windowsNonNeg === 3 &&
      bestNonRaw.oosMonth.beat >= bestNonRaw.oosMonth.hurt &&
      bestNonRaw.deltaUsd >= full.deltaUsd));

const chosen = improved ? bestNonRaw : full;

const shadow = {
  experimentId: 'b-toxic-rank-only-shrink-shadow-2026-07-29',
  recommendWire: false,
  preferredShadow: {
    mode: chosen.mode,
    thr: THR,
    w: W,
    rule:
      chosen.mode === 'full'
        ? `毒+P>=${THR}：用 P' 過閘+排名`
        : chosen.mode === 'rank_only'
          ? `毒+P>=${THR}：過閘用 raw，排名用 P'`
          : `毒+P>=${THR}：過閘用 raw，排名用 P'；若仍占 Rank1 則降到第2`,
  },
  metrics: chosen,
  compared: results,
};

const out = {
  experimentId: 'b-toxic-rank-only-shrink-2026-07-29',
  baseline: summarize(rawAll),
  results,
  chosen,
  recommendation: {
    wireSuggested: false,
    note: improved
      ? '排名專用收縮更優：更新影子主候選'
      : '排名專用未勝過 full p55@0.45：維持現行影子',
  },
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-rank-only-shrink.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
fs.writeFileSync(
  new URL('../tmp-b-toxic-conditional-shrink-shadow.json', import.meta.url),
  JSON.stringify(shadow, null, 2)
);

console.log('RESULTS:');
for (const r of results) {
  console.log(
    `${r.mode.padEnd(22)} Δ$=${r.deltaUsd} win=${r.windowsNonNeg}/3 month ${r.oosMonth.beat}/${r.oosMonth.hurt}/${r.oosMonth.flat} falseKick=${r.falseKickHits.n} toxicR1=${r.toxicRank1Count}`
  );
}
console.log('\nCHOSEN', chosen.mode, 'Δ$', chosen.deltaUsd);
console.log('REC', out.recommendation.note);
