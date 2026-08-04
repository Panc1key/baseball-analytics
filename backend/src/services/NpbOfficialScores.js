/**
 * NPB 歷史比分 — npb.jp 月別日程頁（免費）
 * Yahoo schedule 對過去球季會 fallback，不可用於 2024/2025 回填。
 *
 * 例：https://npb.jp/games/2024/schedule_03_detail.html
 * team1 = 主場、team2 = 客場（與 Odds API 命名一致）
 */

import { mapNpbTeamJaToEn } from './NpbYahooScores.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function normalizeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function npbScheduleDetailUrl(year, month) {
  const mm = String(month).padStart(2, '0');
  return `https://npb.jp/games/${year}/schedule_${mm}_detail.html`;
}

/**
 * @returns {Array<{
 *   dateIso: string,
 *   homeTeam: string,
 *   awayTeam: string,
 *   homeScore: number|null,
 *   awayScore: number|null,
 *   status: string,
 *   gameUrl: string|null,
 *   source: string
 * }>}
 */
export function parseNpbOfficialScheduleHtml(html, yearHint = null) {
  const results = [];
  const cellRe =
    /<div class="team1">([^<]*)<\/div>\s*<a href="(\/scores\/(\d{4})\/(\d{4})\/[^"]+)">([\s\S]*?)<\/a>\s*<div class="team2">([^<]*)<\/div>/g;

  let match;
  while ((match = cellRe.exec(html)) !== null) {
    const homeJa = stripTags(match[1]);
    const path = match[2];
    const year = match[3];
    const mmdd = match[4];
    const inner = match[5];
    const awayJa = stripTags(match[6]);

    if (yearHint != null && String(yearHint) !== year) continue;

    const homeTeam = mapNpbTeamJaToEn(homeJa);
    const awayTeam = mapNpbTeamJaToEn(awayJa);
    if (!homeTeam || !awayTeam) continue;

    const s1Raw = stripTags(inner.match(/class="score1">([^<]*)/)?.[1]);
    const s2Raw = stripTags(inner.match(/class="score2">([^<]*)/)?.[1]);
    const state = stripTags(inner.match(/class="state">([^<]*)/)?.[1]);

    const homeScore = s1Raw !== '' && Number.isFinite(parseInt(s1Raw, 10)) ? parseInt(s1Raw, 10) : null;
    const awayScore = s2Raw !== '' && Number.isFinite(parseInt(s2Raw, 10)) ? parseInt(s2Raw, 10) : null;

    const dateIso = `${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2, 4)}`;
    const completed =
      Number.isFinite(homeScore) &&
      Number.isFinite(awayScore) &&
      (state === '-' || state === '' || /終了/.test(state) || state == null);

    // 中止／無比分
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
      results.push({
        dateIso,
        homeTeam,
        awayTeam,
        homeScore: null,
        awayScore: null,
        status: /中止|キャンセル|延期/.test(inner) ? 'cancelled' : 'scheduled',
        gameUrl: `https://npb.jp${path}`,
        source: 'npb_official',
      });
      continue;
    }

    results.push({
      dateIso,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      status: completed ? 'completed' : 'scheduled',
      gameUrl: `https://npb.jp${path}`,
      source: 'npb_official',
    });
  }
  return results;
}

export async function fetchNpbOfficialMonthScores(year, month) {
  const url = npbScheduleDetailUrl(year, month);
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`NPB official schedule HTTP ${res.status} ${url}`);
  const html = await res.text();
  return parseNpbOfficialScheduleHtml(html, year);
}

/** 抓取多個年月（預設 3–11 月） */
export async function fetchNpbOfficialSeasonScores(year, months = [3, 4, 5, 6, 7, 8, 9, 10, 11]) {
  const all = [];
  for (const month of months) {
    const rows = await fetchNpbOfficialMonthScores(year, month);
    all.push(...rows);
    await new Promise((r) => setTimeout(r, 120));
  }
  return all;
}

export function matchOfficialScoreToGame(game, scores) {
  const home = normalizeKey(game.home_team);
  const away = normalizeKey(game.away_team);
  const day = String(game.commence_time || '').slice(0, 10);
  const jstDay = (() => {
    try {
      return new Date(game.commence_time).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Tokyo',
      });
    } catch {
      return day;
    }
  })();

  const pool = (scores || []).filter((s) => s.dateIso === day || s.dateIso === jstDay);
  const list = pool.length ? pool : scores || [];

  return list.find((y) => {
    if (y.dateIso && y.dateIso !== day && y.dateIso !== jstDay) return false;
    const yh = normalizeKey(y.homeTeam);
    const ya = normalizeKey(y.awayTeam);
    return (
      (yh.includes(home) || home.includes(yh) || yh === home) &&
      (ya.includes(away) || away.includes(ya) || ya === away)
    );
  });
}
