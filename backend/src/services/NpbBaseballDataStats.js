/**
 * NPB 隊級打擊／投球 — プロ野球データFreak（baseball-data.com）
 * 免費 HTML；寫入 team_stats.ops_30 / whip_30 等，供 NpbScoreModel 調 λ
 * https://baseball-data.com/team/hitter.html
 * https://baseball-data.com/team/pitcher.html
 *
 * 注意：為球季累積成績（非嚴格 30 日窗）；回測歷史場次會有前視偏差，實盤初盤可用。
 */

import db from '../db/database.js';
import { ensureRollingColumns, upsertRolling } from './TeamRollingStats.js';
import { mapNpbTeamJaToEn } from './NpbYahooScores.js';
import { config } from '../config.js';

const HITTER_URL = 'https://baseball-data.com/team/hitter.html';
const PITCHER_URL = 'https://baseball-data.com/team/pitcher.html';

function stripTags(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s) {
  const t = String(s || '').trim();
  if (!t || t === '-' || t === '---') return null;
  const n = parseFloat(t.replace(/^\./, '0.'));
  return Number.isFinite(n) ? n : null;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`baseball-data ${url} HTTP ${res.status}`);
  return res.text();
}

function tableBodies(html) {
  return [...html.matchAll(/<table[^>]*id="tbl-(ce|pa)"[^>]*>([\s\S]*?)<\/table>/gi)].map(
    (m) => ({ leagueHalf: m[1], body: m[2] })
  );
}

function rowCells(trHtml) {
  return [...trHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]));
}

/**
 * @returns {Array<{ teamJa: string, teamName: string, avg: number|null, obp: number|null, slg: number|null, ops: number|null, games: number|null }>}
 */
export function parseBaseballDataTeamHitting(html) {
  const out = [];
  for (const { body } of tableBodies(html)) {
    for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = rowCells(tr[1]);
      if (cells.length < 18) continue;
      if (cells[1] === 'チーム' || cells[0] === '順位') continue;
      const teamJa = cells[1];
      const teamName = mapNpbTeamJaToEn(teamJa);
      if (!teamName) continue;
      const avg = parseNum(cells[6]);
      const obp = parseNum(cells[16]);
      const slg = parseNum(cells[17]);
      let ops = parseNum(cells[18]);
      if (ops == null && obp != null && slg != null) ops = Math.round((obp + slg) * 1000) / 1000;
      out.push({
        teamJa,
        teamName,
        games: parseNum(cells[2]),
        avg,
        obp,
        slg,
        ops,
        source: 'baseball-data',
      });
    }
  }
  return out;
}

/**
 * @returns {Array<{ teamJa: string, teamName: string, era: number|null, whip: number|null, games: number|null }>}
 */
export function parseBaseballDataTeamPitching(html) {
  const out = [];
  for (const { body } of tableBodies(html)) {
    for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = rowCells(tr[1]);
      if (cells.length < 18) continue;
      if (cells[1] === 'チーム' || cells[0] === '順位') continue;
      const teamJa = cells[1];
      const teamName = mapNpbTeamJaToEn(teamJa);
      if (!teamName) continue;
      const era = parseNum(cells[6]);
      let whip = null;
      for (let i = cells.length - 1; i >= 10; i--) {
        const n = parseNum(cells[i]);
        if (n != null && n >= 0.7 && n <= 2.2) {
          whip = n;
          break;
        }
      }
      out.push({
        teamJa,
        teamName,
        games: parseNum(cells[2]),
        era,
        whip,
        source: 'baseball-data',
      });
    }
  }
  return out;
}

export async function fetchBaseballDataTeamHitting() {
  return parseBaseballDataTeamHitting(await fetchHtml(HITTER_URL));
}

export async function fetchBaseballDataTeamPitching() {
  return parseBaseballDataTeamPitching(await fetchHtml(PITCHER_URL));
}

/**
 * 抓取並寫入 NPB team_stats 的 OPS/OBP/SLG/ERA/WHIP
 */
export async function refreshNpbBaseballDataTeamForm() {
  ensureRollingColumns();
  const [hitting, pitching] = await Promise.all([
    fetchBaseballDataTeamHitting(),
    fetchBaseballDataTeamPitching(),
  ]);

  const byTeam = new Map();
  for (const h of hitting) {
    byTeam.set(h.teamName, {
      league: 'NPB',
      team_name: h.teamName,
      avg_30: h.avg,
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
      league: 'NPB',
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
    sample: [...byTeam.values()].slice(0, 3).map((r) => ({
      team: r.team_name,
      ops: r.ops_30,
      whip: r.whip_30,
      era: r.era_30,
    })),
  };
}
