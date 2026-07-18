/**
 * KBO 隊級打擊／投球 — 韓國棒球委員會官網英文頁（免費、無需 key）
 * https://eng.koreabaseball.com/Stats/TeamStats.aspx
 *
 * 單頁含 OPS / ERA / WHIP；寫入 team_stats 供 NpbScoreModel 調 λ。
 * 注意：球季累積；回測歷史有前視偏差，實盤初盤可用。
 * 使用者本機若打不開官網，不影響後端伺服器抓取。
 */

import db from '../db/database.js';
import { ensureRollingColumns, upsertRolling } from './TeamRollingStats.js';
import { mapKboTeamToEn } from './KboNaverScores.js';
import { config } from '../config.js';

const TEAM_STATS_URL = 'https://eng.koreabaseball.com/Stats/TeamStats.aspx';

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
  const t = String(s || '').trim().replace(/,/g, '');
  if (!t || t === '-' || t === '---') return null;
  const n = parseFloat(t.replace(/^\./, '0.'));
  return Number.isFinite(n) ? n : null;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`kbo-official ${url} HTTP ${res.status}`);
  return res.text();
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
 * @returns {{
 *   hitting: Array<{ teamCode: string, teamName: string, ops: number|null, obp: number|null, slg: number|null }>,
 *   pitching: Array<{ teamCode: string, teamName: string, era: number|null, whip: number|null }>
 * }}
 */
export function parseKboOfficialTeamStats(html) {
  const tables = parseTables(html);
  const hitting = [];
  const pitchingEra = new Map();
  const pitchingWhip = new Map();

  for (const body of tables) {
    const rows = parseRows(body);
    if (rows.length < 2) continue;
    const header = rows[0].map((h) => h.toUpperCase());
    const opsIdx = headerIndex(header, 'OPS');
    const whipIdx = headerIndex(header, 'WHIP');
    const eraIdx = headerIndex(header, 'ERA');
    const obpIdx = headerIndex(header, 'OBP');
    const slgIdx = headerIndex(header, 'SLG');

    for (const cells of rows.slice(1)) {
      const code = String(cells[0] || '').trim().toUpperCase();
      const teamName = mapKboTeamToEn(code);
      if (!teamName) continue;

      if (opsIdx >= 0) {
        hitting.push({
          teamCode: code,
          teamName,
          ops: parseNum(cells[opsIdx]),
          obp: obpIdx >= 0 ? parseNum(cells[obpIdx]) : null,
          slg: slgIdx >= 0 ? parseNum(cells[slgIdx]) : null,
          source: 'kbo-official',
        });
      }
      if (eraIdx >= 0) {
        pitchingEra.set(teamName, {
          teamCode: code,
          teamName,
          era: parseNum(cells[eraIdx]),
        });
      }
      if (whipIdx >= 0) {
        pitchingWhip.set(teamName, {
          teamCode: code,
          teamName,
          whip: parseNum(cells[whipIdx]),
        });
      }
    }
  }

  const pitching = [];
  const names = new Set([...pitchingEra.keys(), ...pitchingWhip.keys()]);
  for (const teamName of names) {
    const e = pitchingEra.get(teamName);
    const w = pitchingWhip.get(teamName);
    pitching.push({
      teamCode: e?.teamCode || w?.teamCode,
      teamName,
      era: e?.era ?? null,
      whip: w?.whip ?? null,
      source: 'kbo-official',
    });
  }

  return { hitting, pitching };
}

export async function fetchKboOfficialTeamStats() {
  const html = await fetchHtml(TEAM_STATS_URL);
  return parseKboOfficialTeamStats(html);
}

/**
 * 抓取並寫入 KBO team_stats 的 OPS/OBP/SLG/ERA/WHIP
 */
export async function refreshKboOfficialTeamForm() {
  ensureRollingColumns();
  const { hitting, pitching } = await fetchKboOfficialTeamStats();
  if (!hitting.length) throw new Error('kbo-official: 無打擊 OPS 列');

  const byTeam = new Map();
  for (const h of hitting) {
    byTeam.set(h.teamName, {
      league: 'KBO',
      team_name: h.teamName,
      avg_30: null,
      obp_30: h.obp,
      slg_30: h.slg,
      ops_30: h.ops,
      era_30: null,
      whip_30: null,
      rpg_30: null,
      rapg_30: null,
      games_30: null,
      window_days: config.rollingFormDays ?? 30,
    });
  }
  for (const p of pitching) {
    const prev = byTeam.get(p.teamName) || {
      league: 'KBO',
      team_name: p.teamName,
      avg_30: null,
      obp_30: null,
      slg_30: null,
      ops_30: null,
      rpg_30: null,
      rapg_30: null,
      games_30: null,
      window_days: config.rollingFormDays ?? 30,
    };
    prev.era_30 = p.era;
    prev.whip_30 = p.whip;
    byTeam.set(p.teamName, prev);
  }

  const stmt = upsertRolling();
  db.transaction(() => {
    for (const row of byTeam.values()) stmt.run(row);
  })();

  return {
    teams: byTeam.size,
    hitting: hitting.length,
    pitching: pitching.length,
    sample: [...byTeam.values()]
      .sort((a, b) => (b.ops_30 || 0) - (a.ops_30 || 0))
      .slice(0, 3)
      .map((r) => ({
        team: r.team_name,
        ops: r.ops_30,
        whip: r.whip_30,
        era: r.era_30,
      })),
  };
}
