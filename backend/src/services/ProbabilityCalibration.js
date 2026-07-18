/**
 * 可靠度校準：Brier / LogLoss + 分箱校正表
 * p_cal = C(p_raw)，用歷史結算樣本估計
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TABLE_PATH = path.join(__dirname, '../../data/calibration.json');

/** @typedef {{ p: number, y: 0|1 }} OutcomePoint */

export function clamp01(p, lo = 0.02, hi = 0.98) {
  const x = Number(p);
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(lo, Math.min(hi, x));
}

/** Brier score（越小越好）；push 應事先剔除 */
export function brierScore(points) {
  if (!points?.length) return null;
  let s = 0;
  for (const { p, y } of points) {
    const pp = clamp01(p);
    s += (pp - y) ** 2;
  }
  return s / points.length;
}

/** 二元 LogLoss */
export function logLoss(points) {
  if (!points?.length) return null;
  let s = 0;
  for (const { p, y } of points) {
    const pp = clamp01(p);
    s += -(y * Math.log(pp) + (1 - y) * Math.log(1 - pp));
  }
  return s / points.length;
}

function binIndex(p, width, nBins) {
  // 避開 0.7/0.1 → 6.999… 的浮點陷阱
  const idx = Math.floor((Number(p) + 1e-9) / width);
  return Math.min(nBins - 1, Math.max(0, idx));
}

/**
 * 分箱校準：每箱用經驗命中率作為校正後概率
 * @returns {{ bins: Array<{lo,hi,n,avgP,hitRate,calP}>, identity: boolean }}
 */
export function buildBinCalibration(points, binWidth = 0.05) {
  const width = Math.max(0.02, Math.min(0.2, binWidth));
  const bins = [];
  for (let i = 0; i * width < 1 - 1e-12; i += 1) {
    const lo = i * width;
    const hi = Math.min(1, lo + width);
    bins.push({ lo, hi, n: 0, sumP: 0, sumY: 0 });
  }

  for (const { p, y } of points || []) {
    const pp = clamp01(p, 0, 1);
    const idx = binIndex(pp, width, bins.length);
    bins[idx].n += 1;
    bins[idx].sumP += pp;
    bins[idx].sumY += y;
  }

  const out = bins.map((b) => {
    const avgP = b.n ? b.sumP / b.n : (b.lo + b.hi) / 2;
    const hitRate = b.n ? b.sumY / b.n : avgP;
    // 樣本少時向對角收縮
    const shrink = b.n >= 12 ? 1 : b.n / 12;
    const calP = avgP * (1 - shrink) + hitRate * shrink;
    return {
      lo: b.lo,
      hi: b.hi,
      n: b.n,
      avgP: Math.round(avgP * 1000) / 1000,
      hitRate: Math.round(hitRate * 1000) / 1000,
      calP: Math.round(calP * 1000) / 1000,
    };
  });

  const usable = out.filter((b) => b.n >= 5).length;
  // 至少 1 個有效箱即可用；樣本極少時退回對角
  return { bins: out, identity: usable < 1, binWidth: width };
}

export function applyBinCalibration(p, table) {
  if (!table?.bins?.length || table.identity) return clamp01(p);
  const pp = clamp01(p, 0, 1);
  const width = table.binWidth || table.bins[0].hi - table.bins[0].lo || 0.05;
  const bin = table.bins[binIndex(pp, width, table.bins.length)];
  if (!bin || bin.n < 3) return clamp01(p);
  // 箱內線性：相對箱中心的偏移保留一點結構
  const center = (bin.lo + bin.hi) / 2;
  const delta = pp - center;
  return clamp01(bin.calP + delta * 0.35);
}

let cachedTable = null;
let cachedMtime = null;

export function loadCalibrationTable(filePath = DEFAULT_TABLE_PATH) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (cachedTable && cachedMtime === stat.mtimeMs) return cachedTable;
    cachedTable = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cachedMtime = stat.mtimeMs;
    return cachedTable;
  } catch {
    return null;
  }
}

export function saveCalibrationTable(table, filePath = DEFAULT_TABLE_PATH) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(table, null, 2), 'utf8');
  cachedTable = table;
  cachedMtime = Date.now();
}

/**
 * 對模型概率做可靠度校準（若表存在且啟用）
 */
export function applyReliabilityCalibration(p, league = null, market = null) {
  if (config.enableReliabilityCalibration === false) return p;
  const tableDoc = loadCalibrationTable();
  if (!tableDoc) return p;

  const key =
    (league && market && tableDoc.byLeagueMarket?.[`${league}|${market}`]) ||
    (league && tableDoc.byLeague?.[league]) ||
    tableDoc.global ||
    null;
  if (!key) return p;
  return applyBinCalibration(p, key);
}

/**
 * 從回測明細建校準表
 * details: { result: win|loss|push, modelProb, league, market }[]
 */
export function buildCalibrationFromDetails(details) {
  const toPoints = (rows) =>
    rows
      .filter((d) => d.result === 'win' || d.result === 'loss')
      .map((d) => ({
        p: Number(d.modelProb),
        y: d.result === 'win' ? 1 : 0,
      }))
      .filter((x) => Number.isFinite(x.p));

  const all = toPoints(details);
  const global = buildBinCalibration(all);

  const byLeague = {};
  const byLeagueMarket = {};
  for (const league of ['MLB', 'NPB', 'KBO']) {
    const lp = toPoints(details.filter((d) => d.league === league));
    if (lp.length >= 15) byLeague[league] = buildBinCalibration(lp);
    for (const market of ['h2h', 'spreads', 'totals']) {
      const mp = toPoints(
        details.filter((d) => d.league === league && d.market === market)
      );
      if (mp.length >= 12) byLeagueMarket[`${league}|${market}`] = buildBinCalibration(mp);
    }
  }

  return {
    modelVersion: config.modelVersion,
    builtAt: new Date().toISOString(),
    n: all.length,
    metrics: {
      brier: brierScore(all),
      logLoss: logLoss(all),
    },
    global,
    byLeague,
    byLeagueMarket,
  };
}

/** 校準曲線摘要（供回測報告） */
export function formatCalibrationCurve(table) {
  if (!table?.bins?.length) return '(無校準表)';
  return table.bins
    .filter((b) => b.n > 0)
    .map(
      (b) =>
        `[${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}) n=${b.n} pred=${(b.avgP * 100).toFixed(1)}% hit=${(b.hitRate * 100).toFixed(1)}%`
    )
    .join('\n');
}
