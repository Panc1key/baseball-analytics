/**
 * 收窄毒切片收縮門檻：減少誤踢會中場
 *
 * 只對 pickAway && homeWinPct>=65% 且 modelP >= thr 做：
 *   P' = (1-w)*P + w/odds
 *
 * 網格：thr ∈ {0.55,0.56,0.57,0.58,0.60} × w ∈ {0.35,0.45,0.55,0.65}
 * 評分：三窗≥raw、OOS月 beat≥hurt、ΣΔ$、誤踢會中數
 *
 * 用法：node scripts/auditMlbToxicNarrowPShrink.mjs
 * 產物：tmp-b-toxic-narrow-p-shrink.json
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
const THR_GRID = [0.55, 0.56, 0.57, 0.58, 0.6];
const W_GRID = [0.35, 0.45, 0.55, 0.65];

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

function selectB(cands, thr, w) {
  const byDay = new Map();
  for (const c of cands) {
    let modelProb = c.modelProbRaw;
    if (isToxic(c) && w > 0 && c.modelProbRaw >= thr) {
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
  return { falseKickHitN: n, falseKickHitUsd: usd };
}

const candidates = buildCandidates();
const rawAll = selectB(candidates, 1, 0); // thr=1 means never shrink
const rawSum = summarize(rawAll);
const months = [...new Set(candidates.map((c) => c.month))].sort();
const oosMonths = months.slice(WARMUP);

const trials = [];
for (const thr of THR_GRID) {
  for (const w of W_GRID) {
    const bets = selectB(candidates, thr, w);
    const s = summarize(bets);
    const byWindow = {};
    let winNonNeg = 0;
    for (const win of WINDOWS) {
      const bs = summarize(bets.filter((x) => x.window === win.key));
      const rs = summarize(rawAll.filter((x) => x.window === win.key));
      byWindow[win.key] = { ...bs, deltaUsd: bs.usd50 - rs.usd50 };
      if (bs.usd50 - rs.usd50 >= 0) winNonNeg += 1;
    }

    let beat = 0;
    let hurt = 0;
    let flat = 0;
    let sumDelta = 0;
    let falseKickHitN = 0;
    let falseKickHitUsd = 0;
    for (const m of oosMonths) {
      const rawM = selectB(
        candidates.filter((c) => c.month === m),
        1,
        0
      );
      const optM = selectB(
        candidates.filter((c) => c.month === m),
        thr,
        w
      );
      const d = summarize(optM).usd50 - summarize(rawM).usd50;
      sumDelta += d;
      if (d > 0) beat += 1;
      else if (d < 0) hurt += 1;
      else flat += 1;
      const fk = falseKickHits(rawM, optM);
      falseKickHitN += fk.falseKickHitN;
      falseKickHitUsd += fk.falseKickHitUsd;
    }

    const fkAll = falseKickHits(rawAll, bets);

    trials.push({
      thr,
      w,
      kept: s,
      deltaUsd: s.usd50 - rawSum.usd50,
      deltaHrPp:
        s.hitRate != null && rawSum.hitRate != null
          ? Number(((s.hitRate - rawSum.hitRate) * 100).toFixed(2))
          : null,
      deltaBets: s.bets - rawSum.bets,
      byWindow,
      windowsNonNeg: winNonNeg,
      oosMonth: { beat, hurt, flat, sumDeltaUsd: sumDelta },
      falseKickHitsAll: fkAll,
      falseKickHitsOos: { falseKickHitN, falseKickHitUsd },
      score:
        (winNonNeg === 3 ? 1000 : winNonNeg * 200) +
        (beat - hurt) * 50 +
        sumDelta * 0.1 -
        fkAll.falseKickHitN * 20,
    });
  }
}

trials.sort((a, b) => b.score - a.score || b.deltaUsd - a.deltaUsd);

const baseline55 = trials.find((t) => t.thr === 0.55 && t.w === 0.45);
const best = trials[0];
const bestStable = trials.find(
  (t) =>
    t.windowsNonNeg === 3 &&
    t.oosMonth.beat >= t.oosMonth.hurt &&
    t.deltaUsd > 0
);

const out = {
  experimentId: 'b-toxic-narrow-p-shrink-2026-07-29',
  goal: '收窄 P 門檻，減少誤踢會中場，同時保三窗與月穩健',
  baseline: rawSum,
  baselineShadow_p55_w045: baseline55 || null,
  top10: trials.slice(0, 10),
  bestByScore: best,
  bestPassingGates: bestStable || null,
  recommendation: {
    wireSuggested: false,
    nextShadow: bestStable || best,
    note: bestStable
      ? '找到三窗不傷且 OOS 月 beat≥hurt 的收窄版：升格影子主候選，仍不接入正式 B'
      : '收窄後尚未同時過三窗+月穩健：保留原 p55@0.45，或取誤踢最少的折衷',
  },
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-narrow-p-shrink.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('BASELINE', rawSum);
console.log('\n相對 p55@0.45:');
if (baseline55) {
  console.log(
    `p55@0.45 Δ$=${baseline55.deltaUsd} win=${baseline55.windowsNonNeg}/3 month ${baseline55.oosMonth.beat}/${baseline55.oosMonth.hurt}/${baseline55.oosMonth.flat} falseKickHits=${baseline55.falseKickHitsAll.falseKickHitN}`
  );
}
console.log('\nTOP 8:');
for (const t of trials.slice(0, 8)) {
  console.log(
    `P>=${t.thr} w=${t.w} | Δ$=${t.deltaUsd} win=${t.windowsNonNeg}/3 month ${t.oosMonth.beat}/${t.oosMonth.hurt}/${t.oosMonth.flat} sumΔ$${t.oosMonth.sumDeltaUsd} falseKick=${t.falseKickHitsAll.falseKickHitN}($${t.falseKickHitsAll.falseKickHitUsd})`
  );
}
console.log('\nBEST PASSING GATES', bestStable);
console.log('REC', out.recommendation.note);
