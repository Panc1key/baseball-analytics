/**
 * KBO 當日先發 — 官網 GetKboGameList + PitcherDetail
 * 供 NpbScoreModel 調整 λ（王牌日 vs 軟先發）
 */

import { config } from '../config.js';
import { mapKboTeamToEn } from './KboNaverScores.js';

const SCHEDULE_URL = 'https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList';
const PITCHER_DETAIL_URL =
  'https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** @type {Map<string, { at: number, rows: object[] }>} */
const scheduleCache = new Map();
/** @type {Map<string, { at: number, stats: object|null }>} */
const statsCache = new Map();

const CACHE_TTL_MS = 30 * 60 * 1000;

function normalizeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function kstDateYmd(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function toYmdCompact(ymd) {
  return String(ymd || '').replace(/-/g, '');
}

function stripTags(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s) {
  const t = String(s || '')
    .trim()
    .replace(/,/g, '');
  if (!t || t === '-' || t === '---') return null;
  const n = parseFloat(t.replace(/^\./, '0.'));
  return Number.isFinite(n) ? n : null;
}

/** KBO IP 常寫成「87 2/3」 */
export function parseKboInnings(s) {
  const t = String(s || '').trim();
  const frac = t.match(/^(\d+)\s+(\d+)\/3$/);
  if (frac) return Number(frac[1]) + Number(frac[2]) / 3;
  return parseNum(t);
}

function parseTables(html) {
  return [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1]);
}

function parseRows(tableHtml) {
  const rows = [];
  for (const tr of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      stripTags(c[1])
    );
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function headerIndex(headerRow, name) {
  const target = String(name).toUpperCase();
  return headerRow.findIndex((h) => String(h).toUpperCase() === target);
}

/**
 * @returns {{ era, whip, inningsPitched, strikeOuts, walks, hits, gamesStarted, wins, losses, name }|null}
 */
export function parseKboPitcherDetailHtml(html) {
  const tables = parseTables(html);
  let era = null;
  let whip = null;
  let inningsPitched = null;
  let wins = null;
  let losses = null;
  let strikeOuts = null;
  let walks = null;
  let hits = null;
  let games = null;

  for (const body of tables) {
    const rows = parseRows(body);
    if (rows.length < 2) continue;
    const header = rows[0].map((h) => h.toUpperCase());
    const eraIdx = headerIndex(header, 'ERA');
    const whipIdx = headerIndex(header, 'WHIP');
    const ipIdx = headerIndex(header, 'IP');
    const wIdx = headerIndex(header, 'W');
    const lIdx = headerIndex(header, 'L');
    const soIdx = headerIndex(header, 'SO');
    const bbIdx = headerIndex(header, 'BB');
    const hIdx = headerIndex(header, 'H');
    const gIdx = headerIndex(header, 'G');

    // 賽季累積表：含 ERA+IP 或 ERA+WHIP；略過逐場「일자」表
    if (headerIndex(header, '일자') >= 0) continue;
    const data = rows[1];
    if (!data) continue;

    if (eraIdx >= 0 && era == null) era = parseNum(data[eraIdx]);
    if (whipIdx >= 0 && whip == null) whip = parseNum(data[whipIdx]);
    if (ipIdx >= 0 && inningsPitched == null) inningsPitched = parseKboInnings(data[ipIdx]);
    if (wIdx >= 0 && wins == null) wins = parseNum(data[wIdx]);
    if (lIdx >= 0 && losses == null) losses = parseNum(data[lIdx]);
    if (soIdx >= 0 && strikeOuts == null) strikeOuts = parseNum(data[soIdx]);
    if (bbIdx >= 0 && walks == null) walks = parseNum(data[bbIdx]);
    if (hIdx >= 0 && hits == null) hits = parseNum(data[hIdx]);
    if (gIdx >= 0 && games == null) games = parseNum(data[gIdx]);
  }

  if (era == null) return null;
  return {
    era,
    whip: whip ?? 1.46,
    inningsPitched,
    strikeOuts,
    walks,
    hits,
    gamesStarted: games,
    wins,
    losses,
  };
}

export function parseKboGameListPayload(data) {
  const games = Array.isArray(data?.game) ? data.game : [];
  const rows = [];
  for (const g of games) {
    const homeTeamEn = mapKboTeamToEn(g.HOME_NM) || mapKboTeamToEn(g.HOME_ID);
    const awayTeamEn = mapKboTeamToEn(g.AWAY_NM) || mapKboTeamToEn(g.AWAY_ID);
    if (!homeTeamEn || !awayTeamEn) continue;
    const homeId = g.B_PIT_P_ID != null && g.B_PIT_P_ID !== '' ? Number(g.B_PIT_P_ID) : null;
    const awayId = g.T_PIT_P_ID != null && g.T_PIT_P_ID !== '' ? Number(g.T_PIT_P_ID) : null;
    rows.push({
      gameId: g.G_ID,
      date: g.G_DT,
      homeTeamEn,
      awayTeamEn,
      home: homeId
        ? { id: homeId, nameKo: String(g.B_PIT_P_NM || '').trim() || null }
        : null,
      away: awayId
        ? { id: awayId, nameKo: String(g.T_PIT_P_NM || '').trim() || null }
        : null,
    });
  }
  return rows;
}

export async function fetchKboSchedulePitchers(dateYmd) {
  const ymd = String(dateYmd || '').includes('-')
    ? String(dateYmd)
    : `${String(dateYmd).slice(0, 4)}-${String(dateYmd).slice(4, 6)}-${String(dateYmd).slice(6, 8)}`;
  const cached = scheduleCache.get(ymd);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;

  const compact = toYmdCompact(ymd);
  const body = new URLSearchParams({
    leId: '1',
    srId: '0,1,3,4,5,6,7,9',
    date: compact,
  });
  const res = await fetch(SCHEDULE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': UA,
      Referer: 'https://www.koreabaseball.com/',
      Origin: 'https://www.koreabaseball.com',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body,
  });
  if (!res.ok) throw new Error(`KBO GetKboGameList HTTP ${res.status}`);
  const data = await res.json();
  const rows = parseKboGameListPayload(data);
  scheduleCache.set(ymd, { at: Date.now(), rows });
  return rows;
}

export async function getKboPitcherSeasonStats(playerId) {
  if (playerId == null || playerId === '') return null;
  const key = String(playerId);
  const cached = statsCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.stats;

  const url = `${PITCHER_DETAIL_URL}?playerId=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml',
      Referer: 'https://www.koreabaseball.com/',
    },
  });
  if (!res.ok) {
    statsCache.set(key, { at: Date.now(), stats: null });
    return null;
  }
  const html = await res.text();
  const stats = parseKboPitcherDetailHtml(html);
  statsCache.set(key, { at: Date.now(), stats });
  return stats;
}

export function matchKboPitchersToGame(homeTeam, awayTeam, scheduleRows) {
  const homeKey = normalizeKey(homeTeam);
  const awayKey = normalizeKey(awayTeam);
  return (
    (scheduleRows || []).find((r) => {
      const hk = normalizeKey(r.homeTeamEn);
      const ak = normalizeKey(r.awayTeamEn);
      return (
        (hk === homeKey || hk.includes(homeKey) || homeKey.includes(hk)) &&
        (ak === awayKey || ak.includes(awayKey) || awayKey.includes(ak))
      );
    }) || null
  );
}

/**
 * @returns {{
 *   homePitcherStats, awayPitcherStats,
 *   homePitcherName, awayPitcherName,
 *   homePitcherId, awayPitcherId
 * }}
 */
export async function resolveKboPitchersForGame(homeTeam, awayTeam, commenceTime, options = {}) {
  const empty = {
    homePitcherStats: null,
    awayPitcherStats: null,
    homePitcherName: null,
    awayPitcherName: null,
    homePitcherId: null,
    awayPitcherId: null,
  };
  if (config.enableKboPitchers === false) return empty;

  try {
    const ymd = options.dateYmd || kstDateYmd(commenceTime || Date.now());
    if (!ymd) return empty;
    const rows = options.scheduleRows || (await fetchKboSchedulePitchers(ymd));
    const matched = matchKboPitchersToGame(homeTeam, awayTeam, rows);
    if (!matched) return empty;

    const [homeStats, awayStats] = await Promise.all([
      matched.home?.id != null ? getKboPitcherSeasonStats(matched.home.id) : null,
      matched.away?.id != null ? getKboPitcherSeasonStats(matched.away.id) : null,
    ]);

    return {
      homePitcherStats: homeStats,
      awayPitcherStats: awayStats,
      homePitcherName: matched.home?.nameKo || null,
      awayPitcherName: matched.away?.nameKo || null,
      homePitcherId: matched.home?.id ?? null,
      awayPitcherId: matched.away?.id ?? null,
    };
  } catch (err) {
    console.warn('[KboPitcher] resolve failed:', err.message);
    return empty;
  }
}

/** 測試／同步前預熱當日賽程 */
export function clearKboPitcherCaches() {
  scheduleCache.clear();
  statsCache.clear();
}
