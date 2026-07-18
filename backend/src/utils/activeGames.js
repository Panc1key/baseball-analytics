import { config } from '../config.js';

/** 未完賽且仍在分析窗口內（含已開賽）的 SQL 條件 */
export function activeGameWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  const grace = config.liveGameGraceHours ?? 6;
  const horizon = config.upcomingGameHorizonHours ?? 36;
  return `${p}completed = 0 AND datetime(${p}commence_time) > datetime('now', '-${grace} hours') AND datetime(${p}commence_time) < datetime('now', '+${horizon} hours')`;
}

/**
 * 初盤 Slate 展示窗口：比分析窗口更長保留「已開賽」場次
 * 方便對帳當時初盤推了什麼（不因開賽立刻從列表消失）
 */
export function slateDisplayGameWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  const keepStartedHours = Math.max(config.liveGameGraceHours ?? 6, 12);
  const horizon = config.upcomingGameHorizonHours ?? 48;
  return `${p}completed = 0 AND datetime(${p}commence_time) > datetime('now', '-${keepStartedHours} hours') AND datetime(${p}commence_time) < datetime('now', '+${horizon} hours')`;
}

/**
 * 初盤分析候選：未開賽 + 開賽後 1 小時內（補算／補顯示）
 */
export function prematchAnalyzeGameWhere(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  const afterStartHours = 1;
  const horizon = config.upcomingGameHorizonHours ?? 48;
  return (
    `${p}completed = 0` +
    ` AND datetime(${p}commence_time) > datetime('now', '-${afterStartHours} hours')` +
    ` AND datetime(${p}commence_time) < datetime('now', '+${horizon} hours')`
  );
}

/** 比賽是否已開賽且未完賽（≠ 滾球分析產出；僅狀態標籤） */
export function isGameStarted(commenceTime, completed = false) {
  if (completed || !commenceTime) return false;
  const start = new Date(commenceTime).getTime();
  const now = Date.now();
  const graceMs = (config.liveGameGraceHours ?? 6) * 3600000;
  return start <= now && now - start <= graceMs;
}

/** @deprecated 請用 isGameStarted；保留別名避免舊呼叫報錯 */
export function isGameLive(commenceTime, completed = false) {
  return isGameStarted(commenceTime, completed);
}
