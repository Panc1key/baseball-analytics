/**
 * 拆開條件收縮 Expanding WF 的 hurt 月
 * - 列出每個月選到的規則、Δ$、被改動的毒切片場次
 * - 對照：若該月改用其他 shortlist 候選會怎樣
 * - 找「固定單一規則」在 OOS 月上的 beat/hurt（不做選參）
 *
 * 用法：node scripts/auditMlbToxicConditionalShrinkHurtMonths.mjs
 * 產物：tmp-b-toxic-conditional-shrink-hurt-months.json
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

const SHORTLIST = [
  { policy: 'shrink_ev_ge10_or_p55', w: 0.65 },
  { policy: 'shrink_p_ge55', w: 0.45 },
  { policy: 'shrink_p_ge55', w: 0.5 },
  { policy: 'shrink_ev_ge12', w: 0.5 },
  { policy: 'shrink_p_ge55', w: 0.35 },
  { policy: 'shrink_p_ge55', w: 0.55 },
  { policy: 'shrink_ev_ge08', w: 0.65 },
];

const PREFERRED = { policy: 'shrink_ev_ge10_or_p55', w: 0.65 };

const POLICY_WHEN = {
  shrink_ev_ge10_or_p55: (c, rawEv) => rawEv >= 0.1 || c.modelProbRaw >= 0.55,
  shrink_p_ge55: (c) => c.modelProbRaw >= 0.55,
  shrink_ev_ge12: (_c, rawEv) => rawEv >= 0.12,
  shrink_ev_ge08: (_c, rawEv) => rawEv >= 0.08,
};

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

function selectB(cands, policyId, w) {
  const when = policyId === 'raw' ? () => false : POLICY_WHEN[policyId];
  const byDay = new Map();
  for (const c of cands) {
    const rawEv = c.modelProbRaw * (c.pickOdds - 1) - (1 - c.modelProbRaw);
    let modelProb = c.modelProbRaw;
    let shrunk = false;
    if (policyId !== 'raw' && isToxic(c) && when(c, rawEv)) {
      const market = 1 / c.pickOdds;
      modelProb = c.modelProbRaw * (1 - w) + market * w;
      shrunk = true;
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
      rawEv,
      shrunk,
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

function diffBets(rawBets, optBets) {
  const rawMap = new Map(rawBets.map((b) => [keyOf(b), b]));
  const optMap = new Map(optBets.map((b) => [keyOf(b), b]));
  const dropped = [];
  const added = [];
  const keptChanged = [];

  for (const [k, b] of rawMap) {
    if (!optMap.has(k)) {
      dropped.push({
        day: b.day,
        matchup: `${b.awayTeam} @ ${b.homeTeam}`,
        home: b.homeTeam,
        pickSide: b.pickHome ? 'HOME' : 'AWAY',
        pick: b.pickHome ? b.homeTeam : b.awayTeam,
        rank: b.rank,
        odds: Number(b.pickOdds.toFixed(3)),
        rawP: Number(b.modelProbRaw.toFixed(4)),
        rawEv: Number(b.rawEv.toFixed(4)),
        homeWinPct: Number((b.homeWinPct ?? 0).toFixed(3)),
        hit: b.hit,
        pnlUsd: b.hit ? Math.round((b.pickOdds - 1) * STAKE) : -STAKE,
        toxic: isToxic(b),
      });
    }
  }
  for (const [k, b] of optMap) {
    if (!rawMap.has(k)) {
      added.push({
        day: b.day,
        matchup: `${b.awayTeam} @ ${b.homeTeam}`,
        home: b.homeTeam,
        pickSide: b.pickHome ? 'HOME' : 'AWAY',
        pick: b.pickHome ? b.homeTeam : b.awayTeam,
        rank: b.rank,
        odds: Number(b.pickOdds.toFixed(3)),
        P: Number(b.modelProb.toFixed(4)),
        EV: Number(b.ev.toFixed(4)),
        homeWinPct: Number((b.homeWinPct ?? 0).toFixed(3)),
        hit: b.hit,
        pnlUsd: b.hit ? Math.round((b.pickOdds - 1) * STAKE) : -STAKE,
        toxic: isToxic(b),
        shrunk: !!b.shrunk,
      });
    } else {
      const r = rawMap.get(k);
      if (r.rank !== b.rank || Math.abs(r.ev - b.ev) > 1e-6) {
        keptChanged.push({
          day: b.day,
          matchup: `${b.awayTeam} @ ${b.homeTeam}`,
          home: b.homeTeam,
          pick: b.pickHome ? b.homeTeam : b.awayTeam,
          rawRank: r.rank,
          optRank: b.rank,
          rawEv: Number(r.rawEv.toFixed(4)),
          optEv: Number(b.ev.toFixed(4)),
          hit: b.hit,
          shrunk: !!b.shrunk,
        });
      }
    }
  }

  const droppedUsd = dropped.reduce((a, x) => a + x.pnlUsd, 0);
  const addedUsd = added.reduce((a, x) => a + x.pnlUsd, 0);
  return {
    dropped,
    added,
    keptChanged,
    mechanics: {
      droppedN: dropped.length,
      addedN: added.length,
      droppedUsd,
      addedUsd,
      netFromTurnover: addedUsd - droppedUsd,
    },
  };
}

const candidates = buildCandidates();
const months = [...new Set(candidates.map((c) => c.month))].sort();

// Expanding selection path (same as strict)
const wfRows = [];
for (let i = WARMUP; i < months.length; i += 1) {
  const trainMonths = new Set(months.slice(0, i));
  const testMonth = months[i];
  const train = candidates.filter((c) => trainMonths.has(c.month));
  const test = candidates.filter((c) => c.month === testMonth);
  const trainRaw = summarize(selectB(train, 'raw', 0));
  let best = null;
  for (const cand of SHORTLIST) {
    const s = summarize(selectB(train, cand.policy, cand.w));
    const deltaUsd = s.usd50 - trainRaw.usd50;
    const deltaHr =
      s.hitRate != null && trainRaw.hitRate != null
        ? (s.hitRate - trainRaw.hitRate) * 100
        : 0;
    const score = deltaUsd + deltaHr * 10;
    if (!best || score > best.score) best = { ...cand, score, trainDeltaUsd: deltaUsd };
  }

  const rawBets = selectB(test, 'raw', 0);
  const optBets = selectB(test, best.policy, best.w);
  const preferredBets = selectB(test, PREFERRED.policy, PREFERRED.w);
  const rawSum = summarize(rawBets);
  const optSum = summarize(optBets);
  const prefSum = summarize(preferredBets);
  const diff = diffBets(rawBets, optBets);
  const diffPref = diffBets(rawBets, preferredBets);

  // 若該月改用 shortlist 內每個固定規則
  const alts = SHORTLIST.map((cand) => {
    const s = summarize(selectB(test, cand.policy, cand.w));
    return {
      policy: cand.policy,
      w: cand.w,
      deltaUsd: s.usd50 - rawSum.usd50,
      usd50: s.usd50,
      bets: s.bets,
      hitRate: s.hitRate,
    };
  }).sort((a, b) => b.deltaUsd - a.deltaUsd);

  wfRows.push({
    month: testMonth,
    selected: { policy: best.policy, w: best.w, trainDeltaUsd: best.trainDeltaUsd },
    status:
      optSum.usd50 - rawSum.usd50 > 0
        ? 'beat'
        : optSum.usd50 - rawSum.usd50 < 0
          ? 'hurt'
          : 'flat',
    raw: rawSum,
    selectedOpt: optSum,
    preferredFixed: prefSum,
    deltaSelected: optSum.usd50 - rawSum.usd50,
    deltaPreferred: prefSum.usd50 - rawSum.usd50,
    selectedVsPreferred:
      optSum.usd50 - prefSum.usd50,
    turnover: diff.mechanics,
    turnoverPreferred: diffPref.mechanics,
    dropped: diff.dropped,
    added: diff.added,
    altRankingThatMonth: alts,
    bestAltThatMonth: alts[0],
    regretVsBestAlt: (alts[0]?.deltaUsd ?? 0) - (optSum.usd50 - rawSum.usd50),
  });
}

const hurtMonths = wfRows.filter((r) => r.status === 'hurt');
const beatMonths = wfRows.filter((r) => r.status === 'beat');

// 固定 preferred 在全部 OOS 月的 beat/hurt（不做選參）
const fixedPref = {
  policy: PREFERRED,
  months: wfRows.map((r) => ({
    month: r.month,
    deltaUsd: r.deltaPreferred,
    status:
      r.deltaPreferred > 0 ? 'beat' : r.deltaPreferred < 0 ? 'hurt' : 'flat',
  })),
  beat: wfRows.filter((r) => r.deltaPreferred > 0).length,
  hurt: wfRows.filter((r) => r.deltaPreferred < 0).length,
  flat: wfRows.filter((r) => r.deltaPreferred === 0).length,
  sumDeltaUsd: wfRows.reduce((a, r) => a + r.deltaPreferred, 0),
};

// 選參 WF 為何 hurt：常選錯規則？
const selectionErrors = hurtMonths.map((r) => ({
  month: r.month,
  selected: r.selected,
  deltaSelected: r.deltaSelected,
  deltaPreferred: r.deltaPreferred,
  preferredWouldHaveHelped: r.deltaPreferred > r.deltaSelected,
  bestAlt: r.bestAltThatMonth,
  regretVsBestAlt: r.regretVsBestAlt,
  droppedHits: r.dropped.filter((x) => x.hit).length,
  droppedMisses: r.dropped.filter((x) => !x.hit).length,
  droppedUsd: r.turnover.droppedUsd,
  addedUsd: r.turnover.addedUsd,
  topDropped: r.dropped
    .slice()
    .sort((a, b) => b.pnlUsd - a.pnlUsd)
    .slice(0, 5),
  topAddedMisses: r.added
    .filter((x) => !x.hit)
    .sort((a, b) => a.pnlUsd - b.pnlUsd)
    .slice(0, 5),
}));

// 固定 shortlist 各規則 OOS 月穩健
const fixedRulesOos = SHORTLIST.map((cand) => {
  const monthsEval = wfRows.map((r) => {
    const test = candidates.filter((c) => c.month === r.month);
    const raw = summarize(selectB(test, 'raw', 0));
    const opt = summarize(selectB(test, cand.policy, cand.w));
    return {
      month: r.month,
      deltaUsd: opt.usd50 - raw.usd50,
      status:
        opt.usd50 - raw.usd50 > 0
          ? 'beat'
          : opt.usd50 - raw.usd50 < 0
            ? 'hurt'
            : 'flat',
    };
  });
  return {
    ...cand,
    beat: monthsEval.filter((m) => m.status === 'beat').length,
    hurt: monthsEval.filter((m) => m.status === 'hurt').length,
    flat: monthsEval.filter((m) => m.status === 'flat').length,
    sumDeltaUsd: monthsEval.reduce((a, m) => a + m.deltaUsd, 0),
    months: monthsEval,
  };
}).sort(
  (a, b) =>
    b.beat - b.hurt - (a.beat - a.hurt) || b.sumDeltaUsd - a.sumDeltaUsd
);

const diagnosis = {
  mainIssue:
    'Expanding 選參本身不穩：hurt 月常因訓練窗選到過猛規則，或丟掉當月其實會中的毒單',
  preferredFixedVsExpandingSelect: {
    expandingSelectBeatHurt: `${beatMonths.length}/${hurtMonths.length}`,
    preferredFixedBeatHurt: `${fixedPref.beat}/${fixedPref.hurt}`,
    preferredSumDeltaUsd: fixedPref.sumDeltaUsd,
    expandingSumDeltaUsd: wfRows.reduce((a, r) => a + r.deltaSelected, 0),
  },
  recommendation: null,
};

const bestFixed = fixedRulesOos[0];
diagnosis.recommendation = {
  nextShadow:
    bestFixed.beat >= bestFixed.hurt
      ? bestFixed
      : fixedPref.beat >= fixedPref.hurt
        ? { ...PREFERRED, note: 'preferred 固定參數月穩健優於選參 WF' }
        : PREFERRED,
  wireSuggested: false,
  note:
    bestFixed.beat >= bestFixed.hurt && bestFixed.sumDeltaUsd > 0
      ? '固定單一規則的 OOS 月 beat≥hurt：用固定影子，不要用 expanding 選參當接入依據'
      : '即使固定規則，月級仍不穩：繼續影子，拆特徵／校準下一刀',
};

const out = {
  experimentId: 'b-toxic-conditional-shrink-hurt-months-2026-07-29',
  wfRows,
  hurtMonths: selectionErrors,
  beatMonthSummaries: beatMonths.map((r) => ({
    month: r.month,
    selected: r.selected,
    deltaSelected: r.deltaSelected,
    deltaPreferred: r.deltaPreferred,
    turnover: r.turnover,
  })),
  fixedPreferredOos: fixedPref,
  fixedRulesOos,
  diagnosis,
};

fs.writeFileSync(
  new URL('../tmp-b-toxic-conditional-shrink-hurt-months.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('=== Expanding 選參 vs 固定 preferred ===');
console.log(diagnosis.preferredFixedVsExpandingSelect);
console.log('\n=== Hurt 月拆解 ===');
for (const h of selectionErrors) {
  console.log(
    `${h.month} sel=${h.selected.policy}@${h.selected.w} Δ$${h.deltaSelected} | prefΔ$${h.deltaPreferred} | bestAlt=${h.bestAlt.policy}@${h.bestAlt.w} Δ$${h.bestAlt.deltaUsd} regret=${h.regretVsBestAlt}`
  );
  console.log(
    `  drop hit/miss=${h.droppedHits}/${h.droppedMisses} drop$=${h.droppedUsd} add$=${h.addedUsd}`
  );
}
console.log('\n=== 固定規則 OOS 月穩健排序 ===');
for (const r of fixedRulesOos) {
  console.log(
    `${r.policy}@${r.w} beat/hurt/flat=${r.beat}/${r.hurt}/${r.flat} sumΔ$=${r.sumDeltaUsd}`
  );
}
console.log('\nREC', diagnosis.recommendation);
