/**
 * NPB Yahoo 先發解析（研究）
 * 優先：/stats 投手成績表各隊第一列（先發）
 * 備援：/top 文案「先発・NAME」
 */
import { mapNpbTeamJaToEn } from './NpbYahooScores.js';

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

const JA_TEAMS = [
  '巨人',
  'ヤクルト',
  '阪神',
  '中日',
  '広島',
  'DeNA',
  '横浜',
  '西武',
  'ロッテ',
  'ソフトバンク',
  '日本ハム',
  '日ハム',
  'オリックス',
  '楽天',
];

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en;q=0.8',
};

export async function fetchYahooNpbScheduleCards(ymd) {
  const url = `https://baseball.yahoo.co.jp/npb/schedule/?date=${ymd}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Yahoo schedule HTTP ${res.status}`);
  const html = await res.text();
  const cards = [];
  for (const m of html.matchAll(
    /bb-score__item"[\s\S]*?href="\/npb\/game\/(\d+)\/[\s\S]*?bb-score__homeLogo[^>]*>([^<]+)<[\s\S]*?bb-score__awayLogo[^>]*>([^<]+)</g
  )) {
    const yahooGameId = m[1];
    const homeJa = stripTags(m[2]);
    const awayJa = stripTags(m[3]);
    cards.push({
      yahooGameId,
      homeJa,
      awayJa,
      homeTeam: mapNpbTeamJaToEn(homeJa),
      awayTeam: mapNpbTeamJaToEn(awayJa),
    });
  }
  return cards;
}

/** @deprecated 用 fetchYahooNpbScheduleCards */
export async function fetchYahooNpbGameIdsForDate(ymd) {
  const cards = await fetchYahooNpbScheduleCards(ymd);
  return cards.map((c) => c.yahooGameId);
}

/** 正規化投手顯示名（去空白） */
export function normalizeNpbPitcherName(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/[のがをに].*$/, '')
    .trim();
}

/**
 * /stats 投手成績：各隊表第一位資料列 = 先發
 */
export function parseYahooNpbStartersFromStatsHtml(html) {
  const idx = html.indexOf('投手成績');
  if (idx < 0) return { starters: [], source: 'stats_missing' };
  const chunk = html.slice(idx, idx + 40000);
  const titles = [...chunk.matchAll(/bb-head02__title">([^<]+)</g)].map((m) =>
    stripTags(m[1])
  );
  const tables = [...chunk.matchAll(/class="bb-scoreTable[^"]*"[\s\S]*?<\/table>/g)];
  const starters = [];
  for (let i = 0; i < tables.length; i += 1) {
    const teamJa = titles[i] || null;
    const teamEn = teamJa ? mapNpbTeamJaToEn(teamJa) : null;
    const rows = [...tables[i][0].matchAll(/<tr[\s\S]*?<\/tr>/g)];
    // row0 = header
    const data = rows[1];
    if (!data) continue;
    const cells = [...data[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      stripTags(c[1])
    );
    // ['勝'|'敗'|'', name, era, ip, ...]
    const name = normalizeNpbPitcherName(cells[1] || '');
    if (!name) continue;
    const era = Number.parseFloat(cells[2]);
    const ip = Number.parseFloat(cells[3]);
    starters.push({
      name,
      teamEn,
      teamJa,
      era: Number.isFinite(era) ? era : null,
      ip: Number.isFinite(ip) ? ip : null,
      decision: cells[0] || null,
      ctx: 'stats_first_pitcher',
    });
  }
  return { starters, source: 'stats_first_pitcher' };
}

export function parseYahooNpbStartersFromTopHtml(html) {
  const text = stripTags(html);
  const starters = [];
  const re = /([^。\n]{0,80}?)先発[・･]([^\s、。／\/（(]{1,12})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ctx = m[1] + m[0];
    const name = normalizeNpbPitcherName(m[2]);
    let teamEn = null;
    for (const ja of JA_TEAMS) {
      if (ctx.includes(ja)) {
        teamEn = mapNpbTeamJaToEn(ja);
        break;
      }
    }
    if (name) starters.push({ name, teamEn, ctx: ctx.slice(-80) });
  }
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';
  return { starters, title, source: 'top_senpatsu_text' };
}

function parseTeamsFromTitle(title) {
  const vs = String(title || '').match(
    /([\u3040-\u30ff\u4e00-\u9fffA-Za-z0-9]+)\s*(?:vs\.?|対|－|-)\s*([\u3040-\u30ff\u4e00-\u9fffA-Za-z0-9]+)/i
  );
  if (!vs) return { sideA: null, sideB: null, rawA: null, rawB: null };
  return {
    sideA: mapNpbTeamJaToEn(vs[1]),
    sideB: mapNpbTeamJaToEn(vs[2]),
    rawA: vs[1],
    rawB: vs[2],
  };
}

function assignMissingTeams(starters, teamPool) {
  const knownTeams = new Set(starters.map((s) => s.teamEn).filter(Boolean));
  for (const s of starters) {
    if (s.teamEn) continue;
    const remaining = teamPool.filter((t) => !knownTeams.has(t));
    if (remaining.length === 1) {
      s.teamEn = remaining[0];
      knownTeams.add(remaining[0]);
    }
  }
}

function toByTeam(starters) {
  const byTeam = new Map();
  for (const s of starters) {
    if (s.teamEn && s.name) byTeam.set(s.teamEn, s.name);
  }
  return byTeam;
}

/**
 * @param {string} yahooGameId
 * @param {{ homeTeam?: string|null, awayTeam?: string|null }} [hint]
 */
export async function fetchYahooNpbGameStarters(yahooGameId, hint = {}) {
  const teamPool = [hint.homeTeam, hint.awayTeam].filter(Boolean);

  // 1) stats 投手表（覆蓋率高）
  try {
    const statsUrl = `https://baseball.yahoo.co.jp/npb/game/${yahooGameId}/stats`;
    const statsRes = await fetch(statsUrl, { headers: UA });
    if (statsRes.ok) {
      const statsHtml = await statsRes.text();
      const parsed = parseYahooNpbStartersFromStatsHtml(statsHtml);
      if (parsed.starters.length >= 1) {
        const titleMatch = statsHtml.match(/<title>([^<]+)<\/title>/i);
        const title = titleMatch ? stripTags(titleMatch[1]) : '';
        const titleTeams = parseTeamsFromTitle(title);
        const pool = [
          ...teamPool,
          titleTeams.sideA,
          titleTeams.sideB,
        ].filter(Boolean);
        assignMissingTeams(parsed.starters, [...new Set(pool)]);
        const byTeam = toByTeam(parsed.starters);
        if (byTeam.size >= 1) {
          return {
            yahooGameId,
            homeTeam: hint.homeTeam || null,
            awayTeam: hint.awayTeam || null,
            titleTeams,
            byTeam,
            raw: parsed.starters,
            title,
            parseSource: parsed.source,
          };
        }
      }
    }
  } catch {
    /* fall through */
  }

  // 2) top 文案備援
  const topUrl = `https://baseball.yahoo.co.jp/npb/game/${yahooGameId}/top`;
  const res = await fetch(topUrl, { headers: UA });
  if (!res.ok) throw new Error(`Yahoo game top HTTP ${res.status}`);
  const html = await res.text();
  const parsed = parseYahooNpbStartersFromTopHtml(html);
  const titleTeams = parseTeamsFromTitle(parsed.title);
  const pool = [...teamPool, titleTeams.sideA, titleTeams.sideB].filter(Boolean);
  assignMissingTeams(parsed.starters, [...new Set(pool)]);
  return {
    yahooGameId,
    homeTeam: hint.homeTeam || null,
    awayTeam: hint.awayTeam || null,
    titleTeams,
    byTeam: toByTeam(parsed.starters),
    raw: parsed.starters,
    title: parsed.title,
    parseSource: parsed.source,
  };
}
