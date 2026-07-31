/**
 * Grok 對辯規則影子：B（mismatch P×0.92）+ C 代理（無 IL 日期時的回歸近似）
 * 正式常數不改。產物：tmp-shadow-grok-debate-bc.json
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
const DROP_R3 = 0.5;
const DROP_R2_MAX = 1.95;
const DROP_R2_MIN = 1.85;
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

function sideStats(features, side) {
  const s = features?.pitchers?.[side] || {};
  const r = features?.pitchers?.[`${side}Recent`] || {};
  return {
    era: Number(s.era),
    ip: Number(s.inningsPitched),
    gs: Number(s.gamesStarted),
    rest: Number(r.restDays),
  };
}

/** Grok B：對手精英 + 己方小樣本高 ERA → P×0.92 */
function triggerB(mine, opp) {
  return (
    Number.isFinite(opp.era) &&
    opp.era <= 3.4 &&
    Number.isFinite(mine.era) &&
    mine.era >= 5.5 &&
    Number.isFinite(mine.ip) &&
    mine.ip < 40
  );
}

/**
 * C 真旗標需要 IL exit 日期——庫內沒有。
 * 代理（賽前可知近似）：
 *  - C1：rest≥12 且 season IP&lt;30（長休+低工作量）
 *  - C2：ERA≥6 且 IP&lt;40（極端帳面+小樣本）
 *  - C3：C1 或 C2
 */
function triggerC1(mine) {
  return Number.isFinite(mine.rest) && mine.rest >= 12 && Number.isFinite(mine.ip) && mine.ip < 30;
}
function triggerC2(mine) {
  return Number.isFinite(mine.era) && mine.era >= 6 && Number.isFinite(mine.ip) && mine.ip < 40;
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

function selectDays(cands) {
  const byDay = new Map();
  for (const c of cands) {
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day).push(c);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort()) {
    let slots = [...byDay.get(day)].sort(
      (a, b) => b.score - a.score || b.margin - a.margin
    );
    slots = slots.slice(0, 3);
    if (slots.length >= 3 && slots[2].margin < DROP_R3) slots = slots.slice(0, 2);
    if (
      slots.length >= 2 &&
      slots[1].pickOdds >= DROP_R2_MIN &&
      slots[1].pickOdds < DROP_R2_MAX
    ) {
      slots = [slots[0], ...slots.slice(2)];
    }
    out.push(...slots);
  }
  return out;
}

/**
 * adjust: 'none' | 'B' | 'C1'|'C2'|'C3'
 * mode: multiply P then re-check gates; if fail EV/P → drop from pool
 */
function buildPool(model, adjust) {
  const pool = [];
  let triggerN = 0;
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
      if (pickOdds < RULES.minimumPickOdds || pickOdds > RULES.maximumPickOdds) continue;

      modelProb = applyFrozenToxicShrink(modelProb, pickOdds, { pickHome, homeWinPct });

      const mine = sideStats(features, pickHome ? 'home' : 'away');
      const opp = sideStats(features, pickHome ? 'away' : 'home');
      let triggered = false;
      if (adjust === 'B' && triggerB(mine, opp)) {
        modelProb *= 0.92;
        triggered = true;
      } else if (adjust === 'C1' && triggerC1(mine)) {
        modelProb *= 0.9;
        triggered = true;
      } else if (adjust === 'C2' && triggerC2(mine)) {
        modelProb *= 0.9;
        triggered = true;
      } else if (adjust === 'C3' && (triggerC1(mine) || triggerC2(mine))) {
        modelProb *= 0.9;
        triggered = true;
      } else if (adjust === 'B_and_C3') {
        if (triggerB(mine, opp)) {
          modelProb *= 0.92;
          triggered = true;
        }
        if (triggerC1(mine) || triggerC2(mine)) {
          modelProb *= 0.9;
          triggered = true;
        }
      }
      if (triggered) triggerN += 1;

      const margin = Math.abs(ph - pa);
      const ev = modelProb * (pickOdds - 1) - (1 - modelProb);
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

      pool.push({
        day: hk(row.commenceTime),
        window: w.key,
        pickOdds,
        hit: pickHome === hs > as,
        margin,
        ev,
        score,
        triggered,
      });
    }
  }
  return { pool, triggerN };
}

console.log('[debate-bc] loading model…');
const model = getLatestMlbExpectedRunsValidation().model;

const specs = ['none', 'B', 'C1', 'C2', 'C3', 'B_and_C3'];
const results = {};
let baseline = null;

for (const name of specs) {
  const { pool, triggerN } = buildPool(model, name === 'none' ? 'none' : name);
  const picks = selectDays(pool);
  const merged = summarize(picks);
  const y25 = summarize(picks.filter((p) => p.window === '2025'));
  const y26 = summarize(picks.filter((p) => p.window === '2026'));
  const row = {
    name: name === 'none' ? 'baseline' : name,
    triggerNOnCandidatesBeforeSelect: triggerN,
    triggersOnFinalPicks: picks.filter((p) => p.triggered).length,
    merged,
    byWindow: { '2025': y25, '2026': y26 },
  };
  if (name === 'none') baseline = row;
  else {
    row.delta = {
      n: merged.n - baseline.merged.n,
      hrPp: Number((((merged.hr ?? 0) - (baseline.merged.hr ?? 0)) * 100).toFixed(2)),
      usd50: merged.usd50 - baseline.merged.usd50,
      y25: y25.usd50 - baseline.byWindow['2025'].usd50,
      y26: y26.usd50 - baseline.byWindow['2026'].usd50,
    };
    row.dualGeBase =
      y25.usd50 >= baseline.byWindow['2025'].usd50 &&
      y26.usd50 >= baseline.byWindow['2026'].usd50;
  }
  results[row.name] = row;
  console.log(
    row.name,
    'n=',
    merged.n,
    '$=',
    merged.usd50,
    row.delta
      ? `Δ$=${row.delta.usd50} y25=${row.delta.y25} y26=${row.delta.y26} dual=${row.dualGeBase} trigFinal=${row.triggersOnFinalPicks}`
      : ''
  );
}

const payload = {
  generatedAt: new Date().toISOString(),
  mode: 'shadow_only',
  grokRules: {
    B: 'opp_era<=3.40 && own_era>=5.50 && own_ip<40 → P*=0.92 then re-gate EV',
    C_note: '真 IL exit 日期庫內不存在；C1/C2/C3 為賽前代理',
    C1: 'rest>=12 && ip<30 → P*=0.90',
    C2: 'era>=6 && ip<40 → P*=0.90',
    C3: 'C1 || C2 → P*=0.90',
  },
  results,
  cursorReplyToGrok: {
    agree: [
      '先發質量應優先進得分模型重訓；ERA 優勢排序加權已否決',
      '接受難受但+EV；硬避開 mismatch 不做',
      '雙窗不降為硬約束',
    ],
    dataGap:
      'C 真旗標（days_since_last_il_exit）目前無歷史欄位；需 Stats API IL/transaction 回填才能測真規則',
    next:
      '若 B/C 代理雙窗弱正 → Expanding WF；若負或樣本過薄 → 丟棄敘事、等 v4.6 真特徵',
  },
};

fs.writeFileSync(
  new URL('../tmp-shadow-grok-debate-bc.json', import.meta.url),
  JSON.stringify(payload, null, 2)
);
console.log('wrote tmp-shadow-grok-debate-bc.json');
