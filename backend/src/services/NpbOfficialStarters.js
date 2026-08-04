/**
 * NPB 歷史先發 — npb.jp box.html 投手表第一列（實際先發）
 * Yahoo 日程對過去球季會 fallback，不可用於 2024/2025。
 *
 * 主場：tablefix_b_p；客場：tablefix_t_p
 */

import { mapNpbTeamJaToEn } from './NpbYahooScores.js';
import { parseNpbOfficialScheduleHtml } from './NpbOfficialScores.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function normalizeNpbOfficialPitcherName(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .trim();
}

function firstPitcherFromTable(html, tableId) {
  const re = new RegExp(
    `<table[^>]*id="${tableId}"[^>]*>([\\s\\S]*?)<\\/table>`,
    'i'
  );
  const block = html.match(re)?.[1];
  if (!block) return null;
  const row = block.match(/<tbody>[\s\S]*?<tr>([\s\S]*?)<\/tr>/i)?.[1];
  if (!row) return null;
  const name = stripTags(row.match(/class="player"[^>]*>[\s\S]*?<a[^>]*>([^<]+)</i)?.[1]);
  const href = row.match(/href="(\/bis\/players\/[^"]+)"/i)?.[1];
  const id = href?.match(/\/(\d+)\.html/)?.[1] || null;
  const clean = normalizeNpbOfficialPitcherName(name);
  if (!clean) return null;
  return { id, name: clean, href: href ? `https://npb.jp${href}` : null };
}

/**
 * @returns {{ home: {id,name}|null, away: {id,name}|null, homeTeam, awayTeam }}
 */
export function parseNpbOfficialBoxStarters(html) {
  const away = firstPitcherFromTable(html, 'tablefix_t_p');
  const home = firstPitcherFromTable(html, 'tablefix_b_p');

  // linescore 隊名（可選）
  const ls = html.match(/id="tablefix_ls"[\s\S]*?<\/table>/i)?.[0] || '';
  const teamRows = [...ls.matchAll(/<tr>[\s\S]*?<th[^>]*>([^<]+)<\/th>/gi)].map((m) =>
    stripTags(m[1])
  );
  // 通常第一資料列客、第二主；略過表頭空白 th
  const teams = teamRows.filter((t) => t && t !== '&nbsp;' && !/^\d+$/.test(t));
  const awayJa = teams[0] || null;
  const homeJa = teams[1] || null;

  return {
    home: home ? { id: home.id, name: home.name } : null,
    away: away ? { id: away.id, name: away.name } : null,
    homeTeam: homeJa ? mapNpbTeamJaToEn(homeJa) : null,
    awayTeam: awayJa ? mapNpbTeamJaToEn(awayJa) : null,
    source: 'npb_official_box',
  };
}

export async function fetchNpbOfficialBoxStarters(gameUrlOrPath) {
  const base = String(gameUrlOrPath).startsWith('http')
    ? String(gameUrlOrPath)
    : `https://npb.jp${gameUrlOrPath}`;
  const finalUrl = base.includes('box.html')
    ? base
    : `${base.replace(/\/?$/, '/') }box.html`;

  const res = await fetch(finalUrl, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`NPB box HTTP ${res.status} ${finalUrl}`);
  const html = await res.text();
  return {
    ...parseNpbOfficialBoxStarters(html),
    gameUrl: finalUrl.replace(/box\.html$/, ''),
  };
}

/** 從月別日程抽出有比分連結的場次 */
export async function fetchNpbOfficialMonthGameLinks(year, month) {
  const mm = String(month).padStart(2, '0');
  const url = `https://npb.jp/games/${year}/schedule_${mm}_detail.html`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`NPB schedule HTTP ${res.status}`);
  const html = await res.text();
  return parseNpbOfficialScheduleHtml(html, year)
    .filter((g) => g.gameUrl)
    .map((g) => ({
      dateIso: g.dateIso,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      gameUrl: g.gameUrl,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      status: g.status,
    }));
}
