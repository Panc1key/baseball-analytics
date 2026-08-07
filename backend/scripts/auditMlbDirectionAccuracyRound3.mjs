/**
 * 方向準度 Round3：μ＋勝方頭影子家族（分歧規則細化 + Expanding WF）
 *
 * 核心：prod μ 不變；另訓 logistic 勝方頭；分歧時跟盤／跟 logistic／棄權偏主等。
 * 主指標：方向命中／Brier／強主選客；附錄 Locked B（用新方向替換 μ 選邊後重算 EV）。
 *
 * 用法: node scripts/auditMlbDirectionAccuracyRound3.mjs
 * 產物: tmp-direction-accuracy-round3.json
 */
import fs from 'fs';
import db from '../src/db/database.js';
import { resolveMlbParkFactor } from '../src/data/parkFactors.js';
import { getCachedMlbGameWeather } from '../src/services/MlbGameWeatherService.js';
import { MLB_BASELINE_FEATURE_VERSION } from '../src/services/MlbHistoricalBaseline.js';
import {
  getLatestMlbExpectedRunsValidation,
  buildMlbExpectedRunsSideFeatures,
  predictMlbExpectedRunsMean,
  buildMlbScoreDistribution,
  deriveMlbScoreMarkets,
  calibrateMlbScoreMarkets,
  MLB_EXPECTED_RUNS_FEATURE_KEYS,
  MLB_MONEYLINE_RULE_PROFILES,
  scoreMlbMoneylineDailyRank,
} from '../src/services/MlbExpectedRunsModel.js';
import { resolvePitOdds } from '../src/services/PitOddsService.js';
import { buildPregameRegimeSignals } from '../src/services/MlbGameRegimeService.js';

const STRONG = 0.65;
const STAKE = 50;
const B = { ...MLB_MONEYLINE_RULE_PROFILES.ev02_max230, minimumH2hBookmakers: 2 };
const DROP_R3 = 0.5;

function finite(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}
function sigmoid(z) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}
function hk(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
}

function enrichSideVector(base, features, side) {
  const homeWinPct = finite(features?.home?.homeWinPct, 0.5);
  const awayWinPct = finite(features?.away?.awayWinPct, 0.5);
  const homeSeason = finite(features?.home?.seasonWinPct, 0.5);
  const awaySeason = finite(features?.away?.seasonWinPct, 0.5);
  return {
    ...base,
    offenseRoleWinPct: side === 'home' ? homeWinPct : awayWinPct,
    opponentRoleWinPct: side === 'home' ? awayWinPct : homeWinPct,
    seasonWinPctDiffForOffense:
      side === 'home' ? homeSeason - awaySeason : awaySeason - homeSeason,
  };
}

function loadGameRows(fromIso, toIsoExclusive) {
  const rows = db
    .prepare(
      `SELECT f.game_id AS gameId, f.commence_time AS commenceTime, f.features_json AS featuresJson,
              g.home_team AS homeTeam, g.away_team AS awayTeam,
              g.home_score AS homeScore, g.away_score AS awayScore
       FROM mlb_historical_feature_rows f JOIN games g ON g.id = f.game_id
       WHERE f.feature_version = ? AND g.completed = 1
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
         AND datetime(f.commence_time) >= datetime(?)
         AND datetime(f.commence_time) < datetime(?)
       ORDER BY datetime(f.commence_time), f.game_id`
    )
    .all(MLB_BASELINE_FEATURE_VERSION, fromIso, toIsoExclusive);

  const out = [];
  for (const row of rows) {
    let features;
    try {
      features = JSON.parse(row.featuresJson);
    } catch {
      continue;
    }
    const hs = +row.homeScore;
    const as = +row.awayScore;
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue;
    features.parkFactor = resolveMlbParkFactor({
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    features.weather = getCachedMlbGameWeather({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      venueName: features.venueName,
      homeTeam: row.homeTeam,
    });
    const homeVec = enrichSideVector(
      buildMlbExpectedRunsSideFeatures(features, 'home'),
      features,
      'home'
    );
    const awayVec = enrichSideVector(
      buildMlbExpectedRunsSideFeatures(features, 'away'),
      features,
      'away'
    );
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(homeVec[k]))) continue;
    if (!MLB_EXPECTED_RUNS_FEATURE_KEYS.every((k) => Number.isFinite(awayVec[k]))) continue;
    out.push({
      gameId: row.gameId,
      commenceTime: row.commenceTime,
      day: hk(row.commenceTime),
      month: hk(row.commenceTime).slice(0, 7),
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      homeScore: hs,
      awayScore: as,
      features,
      homeVector: homeVec,
      awayVector: awayVec,
      homeWinPct: finite(features?.home?.homeWinPct, 0.5),
      awayWinPct: finite(features?.away?.awayWinPct, 0.5),
      homeSeason: finite(features?.home?.seasonWinPct, 0.5),
      awaySeason: finite(features?.away?.seasonWinPct, 0.5),
      parkFactor: finite(features.parkFactor, 1),
    });
  }
  return out;
}

function fairHome(ho, ao) {
  const ih = 1 / ho;
  const ia = 1 / ao;
  return ih / (ih + ia);
}

function bestH2h(row) {
  const pit = resolvePitOdds(row.gameId, row.commenceTime);
  if (!pit?.bookmakers?.length) return null;
  let best = null;
  for (const book of pit.bookmakers) {
    const m = book.markets?.find((x) => x.key === 'h2h');
    if (!m?.outcomes?.length) continue;
    const home =
      m.outcomes.find((o) => o.name === row.homeTeam) ||
      m.outcomes.find((o) =>
        String(o.name).includes(String(row.homeTeam).split(' ').pop())
      );
    const away =
      m.outcomes.find((o) => o.name === row.awayTeam) ||
      m.outcomes.find((o) =>
        String(o.name).includes(String(row.awayTeam).split(' ').pop())
      );
    if (!home?.price || !away?.price) continue;
    const ho = +home.price;
    const ao = +away.price;
    if (!Number.isFinite(ho) || !Number.isFinite(ao)) continue;
    const vig = 1 / ho + 1 / ao;
    if (!best || vig < best.vig) {
      best = {
        vig,
        homeOdds: ho,
        awayOdds: ao,
        pHome: fairHome(ho, ao),
        books: pit.bookmakers.length,
      };
    }
  }
  return best;
}

const muModel = getLatestMlbExpectedRunsValidation().model;

function attachMu(row) {
  const homeMu = predictMlbExpectedRunsMean(muModel, row.homeVector);
  const awayMu = predictMlbExpectedRunsMean(muModel, row.awayVector);
  const dist = buildMlbScoreDistribution({
    homeMean: homeMu,
    awayMean: awayMu,
    homeDispersion: muModel.dispersion,
    awayDispersion: muModel.dispersion,
  });
  const markets = calibrateMlbScoreMarkets(
    deriveMlbScoreMarkets(dist, { totalLine: 8.5 }),
    muModel.moneylineTemperature ?? 1
  );
  const mkt = bestH2h(row);
  return {
    ...row,
    homeMu,
    awayMu,
    muMargin: homeMu - awayMu,
    pMuHome: markets.homeWinProbability,
    pMktHome: mkt?.pHome ?? null,
    homeOdds: mkt?.homeOdds ?? null,
    awayOdds: mkt?.awayOdds ?? null,
    h2hBooks: mkt?.books ?? 0,
  };
}

function standardizeFit(rows, xFn) {
  const xs = rows.map(xFn);
  const dim = xs[0].length;
  const mean = Array(dim).fill(0);
  const scale = Array(dim).fill(1);
  for (const x of xs) for (let i = 0; i < dim; i += 1) mean[i] += x[i];
  for (let i = 0; i < dim; i += 1) mean[i] /= xs.length;
  for (const x of xs) {
    for (let i = 0; i < dim; i += 1) scale[i] += (x[i] - mean[i]) ** 2;
  }
  for (let i = 0; i < dim; i += 1) {
    scale[i] = Math.max(0.01, Math.sqrt(scale[i] / Math.max(1, xs.length - 1)));
  }
  const z = (x) => x.map((v, i) => (v - mean[i]) / scale[i]);
  return { mean, scale, z, zs: xs.map(z) };
}

function fitLogistic(rows, xFn, { epochs = 800, lr = 0.05, l2 = 0.02 } = {}) {
  const { z, zs } = standardizeFit(rows, xFn);
  const ys = rows.map((r) => (r.homeScore > r.awayScore ? 1 : 0));
  const dim = zs[0].length;
  let w = Array(dim).fill(0);
  let b = 0;
  for (let ep = 0; ep < epochs; ep += 1) {
    const gw = Array(dim).fill(0);
    let gb = 0;
    for (let i = 0; i < zs.length; i += 1) {
      const p = sigmoid(b + zs[i].reduce((s, v, j) => s + w[j] * v, 0));
      const err = p - ys[i];
      gb += err;
      for (let j = 0; j < dim; j += 1) gw[j] += err * zs[i][j];
    }
    const n = zs.length;
    b -= (lr * gb) / n;
    for (let j = 0; j < dim; j += 1) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return {
    predictP(row) {
      const x = z(xFn(row));
      return sigmoid(b + x.reduce((s, v, j) => s + w[j] * v, 0));
    },
  };
}

function xMuHead(row) {
  return [
    row.muMargin,
    row.pMuHome,
    row.homeWinPct,
    row.awayWinPct,
    row.homeWinPct - row.awayWinPct,
    row.homeSeason - row.awaySeason,
    row.parkFactor,
    row.homeMu,
    row.awayMu,
  ];
}

function directionReport(rows, decide) {
  let n = 0;
  let dirHit = 0;
  let brier = 0;
  let strongN = 0;
  let strongAway = 0;
  let strongAwayHomeAct = 0;
  let overrideN = 0;
  let overrideHit = 0;
  for (const row of rows) {
    const d = decide(row);
    const homeWins = row.homeScore > row.awayScore;
    n += 1;
    if (d.pickHome === homeWins) dirHit += 1;
    brier += (d.pHome - (homeWins ? 1 : 0)) ** 2;
    if (d.overridden) {
      overrideN += 1;
      if (d.pickHome === homeWins) overrideHit += 1;
    }
    if (row.homeWinPct >= STRONG) {
      strongN += 1;
      if (!d.pickHome) {
        strongAway += 1;
        if (homeWins) strongAwayHomeAct += 1;
      }
    }
  }
  return {
    games: n,
    directionHitRate: Number((dirHit / n).toFixed(4)),
    moneylineBrier: Number((brier / n).toFixed(5)),
    overrideN,
    overrideHitRate: overrideN ? Number((overrideHit / overrideN).toFixed(4)) : null,
    strongHome: {
      games: strongN,
      muPicksAway: strongAway,
      muPicksAwayRate: strongN ? Number((strongAway / strongN).toFixed(4)) : null,
      whenAwayHomeActual: strongAway
        ? Number((strongAwayHomeAct / strongAway).toFixed(4))
        : null,
    },
  };
}

function lockedBWithDecide(rows, decide) {
  const byDay = new Map();
  for (const row of rows) {
    if (row.h2hBooks < 2 || row.homeOdds == null) continue;
    const pitchers = row.features?.pitchers || {};
    if (
      (pitchers.homeIdentity?.id ?? pitchers.home?.id) == null ||
      (pitchers.awayIdentity?.id ?? pitchers.away?.id) == null
    ) {
      continue;
    }
    const d = decide(row);
    const pickHome = d.pickHome;
    const modelProb = pickHome ? d.pHome : 1 - d.pHome;
    const pickOdds = pickHome ? row.homeOdds : row.awayOdds;
    if (pickOdds < 1.4 || pickOdds > 2.3) continue;
    const sig = buildPregameRegimeSignals(row.features);
    const pickEarly = pickHome
      ? +sig.homeEarlyExitsLast3 || 0
      : +sig.awayEarlyExitsLast3 || 0;
    const oppEarly = pickHome
      ? +sig.awayEarlyExitsLast3 || 0
      : +sig.homeEarlyExitsLast3 || 0;
    if (pickEarly > oppEarly) continue;
    const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
    const margin = Math.abs(row.homeMu - row.awayMu);
    if (ev < B.minimumExpectedValue) continue;
    if (margin < B.minimumExpectedRunMargin) continue;
    if (modelProb < B.minimumModelProbability) continue;
    if (pickOdds < B.minimumPickOdds || pickOdds > B.maximumPickOdds) continue;
    const bScore = scoreMlbMoneylineDailyRank(
      { expectedValue: ev, modelProbability: modelProb },
      B
    );
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day).push({
      pickOdds,
      bScore,
      margin,
      hit: pickHome ? row.homeScore > row.awayScore : row.awayScore > row.homeScore,
    });
  }
  const bets = [];
  for (const day of [...byDay.keys()].sort()) {
    let slots = [...byDay.get(day)]
      .sort((a, b) => b.bScore - a.bScore || b.margin - a.margin)
      .slice(0, 3);
    if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
    if (
      slots.length >= 2 &&
      slots[1].pickOdds >= 1.85 &&
      slots[1].pickOdds < 1.95
    ) {
      slots = [slots[0], ...slots.slice(2)];
    }
    bets.push(...slots);
  }
  let w = 0;
  let u = 0;
  for (const b of bets) {
    if (b.hit) {
      w += 1;
      u += b.pickOdds - 1;
    } else u -= 1;
  }
  return {
    bets: bets.length,
    hitRate: bets.length ? Number((w / bets.length).toFixed(4)) : null,
    usd50: Math.round(u * STAKE),
  };
}

console.log('Loading…');
const all = [
  ...loadGameRows('2024-04-01T00:00:00Z', '2024-10-01T00:00:00Z'),
  ...loadGameRows('2025-04-01T00:00:00Z', '2026-07-23T00:00:00Z'),
].map(attachMu);
all.sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));

const development = all.filter(
  (r) => r.commenceTime >= '2025-05-01T00:00:00Z' && r.commenceTime < '2026-01-01T00:00:00Z'
);
const split = Math.floor(development.length * 0.7);
const trainHold = development.slice(0, split);
const valHold = development.slice(split);
const y2024 = all.filter((r) => r.day.startsWith('2024'));
const y2025 = all.filter((r) => r.day.startsWith('2025'));
const y2026 = all.filter((r) => r.day.startsWith('2026'));

console.log('Fit logistic on holdout train…', trainHold.length);
const logHold = fitLogistic(trainHold, xMuHead);

function makeFamily(logPredictP) {
  return [
    {
      id: 'prod_mu',
      decide: (r) => ({
        pickHome: r.homeMu >= r.awayMu,
        pHome: r.pMuHome,
        overridden: false,
      }),
    },
    {
      id: 'agree_else_market',
      decide: (r) => {
        const muH = r.homeMu >= r.awayMu;
        const logH = logPredictP(r) >= 0.5;
        if (muH === logH) {
          return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        }
        const p = r.pMktHome;
        if (p == null) return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        return { pickHome: p >= 0.5, pHome: p, overridden: true };
      },
    },
    {
      id: 'agree_else_logistic',
      decide: (r) => {
        const muH = r.homeMu >= r.awayMu;
        const pL = logPredictP(r);
        const logH = pL >= 0.5;
        if (muH === logH) {
          return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        }
        return { pickHome: logH, pHome: pL, overridden: true };
      },
    },
    {
      id: 'agree_else_market_only_thin',
      // 僅 |μ分差|<0.5 才允許分歧改邊
      decide: (r) => {
        const muH = r.homeMu >= r.awayMu;
        const logH = logPredictP(r) >= 0.5;
        if (muH === logH || Math.abs(r.muMargin) >= 0.5) {
          return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        }
        const p = r.pMktHome;
        if (p == null) return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        return { pickHome: p >= 0.5, pHome: p, overridden: true };
      },
    },
    {
      id: 'agree_else_market_only_strong_home',
      decide: (r) => {
        const muH = r.homeMu >= r.awayMu;
        const logH = logPredictP(r) >= 0.5;
        if (muH === logH || r.homeWinPct < STRONG) {
          return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        }
        const p = r.pMktHome;
        if (p == null) return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        return { pickHome: p >= 0.5, pHome: p, overridden: true };
      },
    },
    {
      id: 'disagree_only_if_log_confident',
      // |pL-0.5|>=0.08 才跟 logistic／市場
      decide: (r) => {
        const muH = r.homeMu >= r.awayMu;
        const pL = logPredictP(r);
        const logH = pL >= 0.5;
        if (muH === logH || Math.abs(pL - 0.5) < 0.08) {
          return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        }
        const p = r.pMktHome ?? pL;
        return { pickHome: p >= 0.5, pHome: p, overridden: true };
      },
    },
    {
      id: 'blend_disagree_only',
      // 一致用 μ；分歧用 0.5*μ+0.5*log（或市場）
      decide: (r) => {
        const muH = r.homeMu >= r.awayMu;
        const pL = logPredictP(r);
        const logH = pL >= 0.5;
        if (muH === logH) {
          return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        }
        const pM = r.pMktHome ?? pL;
        const p = 0.34 * r.pMuHome + 0.33 * pL + 0.33 * pM;
        return { pickHome: p >= 0.5, pHome: p, overridden: true };
      },
    },
    {
      id: 'veto_away_if_strong_home_disagree',
      // μ 選客且強主且 logistic/市場不同意 → 改主
      decide: (r) => {
        const muH = r.homeMu >= r.awayMu;
        if (muH || r.homeWinPct < STRONG) {
          return { pickHome: muH, pHome: r.pMuHome, overridden: false };
        }
        const pL = logPredictP(r);
        const pM = r.pMktHome;
        const logWantsHome = pL >= 0.5;
        const mktWantsHome = pM == null ? false : pM >= 0.5;
        if (logWantsHome || mktWantsHome) {
          const p = Math.max(pL, pM ?? 0);
          return { pickHome: true, pHome: Math.max(p, 0.5), overridden: true };
        }
        return { pickHome: false, pHome: r.pMuHome, overridden: false };
      },
    },
  ];
}

const family = makeFamily((r) => logHold.predictP(r));

function evalFamily(familyList, windows) {
  return familyList.map((v) => {
    const byWindow = {};
    for (const [key, rows] of Object.entries(windows)) {
      byWindow[key] = {
        direction: directionReport(rows, v.decide),
        lockedB: lockedBWithDecide(rows, v.decide),
      };
    }
    return { id: v.id, byWindow };
  });
}

const holdoutResults = evalFamily(family, {
  val: valHold,
  '2024': y2024,
  '2025': y2025,
  '2026': y2026,
});

// Expanding WF by month: train logistic on all prior months, score next month
console.log('Expanding WF by month…');
const months = [...new Set(all.map((r) => r.month))].sort();
const wfMonths = months.filter((m) => m >= '2025-06' && m <= '2026-07');
const wfByVariant = Object.fromEntries(family.map((v) => [v.id, []]));

for (const month of wfMonths) {
  const trainRows = all.filter((r) => r.month < month && r.month >= '2024-04');
  const testRows = all.filter((r) => r.month === month);
  if (trainRows.length < 400 || testRows.length < 30) continue;
  const log = fitLogistic(trainRows, xMuHead, { epochs: 600, lr: 0.05, l2: 0.02 });
  const fam = makeFamily((r) => log.predictP(r));
  for (const v of fam) {
    const dir = directionReport(testRows, v.decide);
    wfByVariant[v.id].push({
      month,
      trainN: trainRows.length,
      ...dir,
      lockedB: lockedBWithDecide(testRows, v.decide),
    });
  }
  console.log('  scored', month, 'train', trainRows.length, 'test', testRows.length);
}

function summarizeWf(rows) {
  if (!rows.length) return null;
  const dir = rows.reduce((s, r) => s + r.directionHitRate * r.games, 0);
  const games = rows.reduce((s, r) => s + r.games, 0);
  const brier = rows.reduce((s, r) => s + r.moneylineBrier * r.games, 0);
  const usd = rows.reduce((s, r) => s + (r.lockedB?.usd50 || 0), 0);
  const bets = rows.reduce((s, r) => s + (r.lockedB?.bets || 0), 0);
  return {
    months: rows.length,
    games,
    directionHitRate: Number((dir / games).toFixed(4)),
    moneylineBrier: Number((brier / games).toFixed(5)),
    lockedB: { bets, usd50: usd },
  };
}

const baseHold = holdoutResults.find((r) => r.id === 'prod_mu');
const rankedHold = holdoutResults
  .filter((r) => r.id !== 'prod_mu')
  .map((r) => {
    const d26 = r.byWindow['2026'].direction;
    const d24 = r.byWindow['2024'].direction;
    const b26 = baseHold.byWindow['2026'].direction;
    const b24 = baseHold.byWindow['2024'].direction;
    const wf = summarizeWf(wfByVariant[r.id] || []);
    const wfBase = summarizeWf(wfByVariant.prod_mu || []);
    return {
      id: r.id,
      deltaDir2026: Number((d26.directionHitRate - b26.directionHitRate).toFixed(4)),
      deltaBrier2026: Number((d26.moneylineBrier - b26.moneylineBrier).toFixed(5)),
      deltaStrongAway2026: Number(
        (
          (d26.strongHome.muPicksAwayRate ?? 0) -
          (b26.strongHome.muPicksAwayRate ?? 0)
        ).toFixed(4)
      ),
      deltaDir2024: Number((d24.directionHitRate - b24.directionHitRate).toFixed(4)),
      deltaBrier2024: Number((d24.moneylineBrier - b24.moneylineBrier).toFixed(5)),
      lockedB2026: r.byWindow['2026'].lockedB,
      lockedBDelta2026:
        r.byWindow['2026'].lockedB.usd50 - baseHold.byWindow['2026'].lockedB.usd50,
      wf,
      wfDeltaDir: wf && wfBase
        ? Number((wf.directionHitRate - wfBase.directionHitRate).toFixed(4))
        : null,
      wfDeltaUsd: wf && wfBase ? wf.lockedB.usd50 - wfBase.lockedB.usd50 : null,
      override: {
        '2026': {
          n: d26.overrideN,
          hit: d26.overrideHitRate,
        },
        '2024': {
          n: d24.overrideN,
          hit: d24.overrideHitRate,
        },
      },
      byWindow: r.byWindow,
    };
  })
  .sort(
    (a, b) =>
      (b.wfDeltaDir ?? -9) - (a.wfDeltaDir ?? -9) ||
      b.deltaDir2026 - a.deltaDir2026 ||
      a.deltaBrier2026 - b.deltaBrier2026
  );

const pass = rankedHold.find(
  (r) =>
    r.deltaDir2026 >= 0.005 &&
    r.deltaBrier2026 <= 0.001 &&
    r.deltaDir2024 >= 0 &&
    (r.wfDeltaDir ?? -1) >= 0.003 &&
    (r.wfDeltaUsd ?? -9999) >= -200
);

const out = {
  experimentId: 'direction-accuracy-round3-2026-08-07',
  plainLanguage:
    'Round3：μ＋勝方頭分歧規則家族；holdout + 按月 expanding WF；附錄鎖定 B',
  holdoutBaseline: baseHold,
  ranked: rankedHold,
  wfBaseline: summarizeWf(wfByVariant.prod_mu || []),
  wfByVariant: Object.fromEntries(
    Object.entries(wfByVariant).map(([k, rows]) => [k, { summary: summarizeWf(rows), months: rows }])
  ),
  recommendation: {
    wireSuggested: Boolean(pass),
    shadowOnly: true,
    best: rankedHold[0]?.id || null,
    passGate: pass?.id || null,
    note: pass
      ? `${pass.id}：holdout+WF 方向升且 Brier/2024 可接受——建議影子並行（不改正式 μ／選注常數）`
      : rankedHold[0]
        ? `最佳 ${rankedHold[0].id}（WF方向Δ ${rankedHold[0].wfDeltaDir}／2026Δ ${rankedHold[0].deltaDir2026}）未過嚴閘；可續影子觀察不同意改邊命中`
        : '無',
  },
};

fs.writeFileSync(
  new URL('../tmp-direction-accuracy-round3.json', import.meta.url),
  JSON.stringify(out, null, 2)
);

console.log('\nBASE 2026', baseHold.byWindow['2026'].direction);
console.log('WF base', out.wfBaseline);
console.log('\nRANKED:');
for (const r of rankedHold) {
  console.log(
    `${r.id.padEnd(36)} dir26Δ=${r.deltaDir2026} brier26Δ=${r.deltaBrier2026} dir24Δ=${r.deltaDir2024} wfDirΔ=${r.wfDeltaDir} wf$Δ=${r.wfDeltaUsd} LB26$Δ=${r.lockedBDelta2026} ov26=${r.override['2026'].n}@${r.override['2026'].hit}`
  );
}
console.log('\nREC', out.recommendation.note);
