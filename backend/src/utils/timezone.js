/**
 * 香港時區（UTC+8）日期工具 — 用於按日 Slate 分組
 */
import { config } from '../config.js';

export const HK_TIMEZONE = config.displayTimezone || 'Asia/Hong_Kong';

/** ISO 時間 → 香港日曆日 YYYY-MM-DD */
export function toLocalDateKey(isoString, timeZone = HK_TIMEZONE) {
  if (!isoString) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoString));
}

/** 香港日曆日 → 顯示標籤，如「7月14日 週二」 */
export function formatLocalDateLabel(dateKey, timeZone = HK_TIMEZONE) {
  if (!dateKey) return '';
  const [y, m, d] = dateKey.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 4, 0, 0));
  const weekday = new Intl.DateTimeFormat('zh-HK', { timeZone, weekday: 'short' }).format(noonUtc);
  return `${m}月${d}日 ${weekday}`;
}

/** 香港時區時分 */
export function formatLocalTime(isoString, timeZone = HK_TIMEZONE) {
  if (!isoString) return '';
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(isoString));
}

/** 今天（香港）YYYY-MM-DD */
export function todayLocalDateKey(timeZone = HK_TIMEZONE) {
  return toLocalDateKey(new Date().toISOString(), timeZone);
}

/** 偏移 N 天的香港日期 */
export function addDaysToDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** SQLite 香港日曆日表達式（commence_time 欄位） */
export function sqliteLocalDateExpr(column = 'g.commence_time', offsetHours = 8) {
  return `date(datetime(${column}, '+${offsetHours} hours'))`;
}
