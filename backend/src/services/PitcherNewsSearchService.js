/**
 * 投手相關新聞檢索（免費 Google News RSS）。
 * 只負責找材料，不做推論；國際資訊由此層取得，再交給 DeepSeek 抽取。
 */
function decodeXml(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value = '') {
  return decodeXml(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
    || block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : null;
}

export function parseGoogleNewsRss(xml, { limit = 12 } = {}) {
  const items = [];
  const regex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = regex.exec(String(xml || ''))) && items.length < limit) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const url = extractTag(block, 'link') || extractTag(block, 'guid');
    if (!title || !url) continue;
    items.push({
      title,
      url,
      publishedAt: extractTag(block, 'pubDate'),
      snippet: stripHtml(extractTag(block, 'description') || '').slice(0, 400),
      source: 'google_news_rss',
    });
  }
  return items;
}

function materialScore(item) {
  const text = `${item.title || ''} ${item.snippet || ''}`;
  let score = 0;
  if (/injur|IL|surgery|scratch|disabled list|Tommy|UCL|elbow|shoulder|手術|負傷|離脱|復帰|부상|수술/i.test(text)) {
    score += 5;
  }
  if (/return from|activated|rehab|workload|opener|歸隊|復出/i.test(text)) {
    score += 3;
  }
  if (/betmgm|bonus code|betting odds|promo/i.test(text)) score -= 6;
  if (/recap|final score|box score|highlights/i.test(text)) score -= 3;
  return score;
}

function rankAndFilterMaterials(items, limit) {
  return [...items]
    .map((item) => ({ ...item, score: materialScore(item) }))
    .filter((item) => item.score > -3)
    .sort((a, b) => b.score - a.score || String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    .slice(0, limit)
    .map(({ score, ...item }) => item);
}

function buildQueries({ pitcherName, teamName = null, league = null }) {
  const name = String(pitcherName || '').trim();
  if (!name) return [];
  const team = teamName ? ` "${teamName}"` : '';
  const code = String(league || '').toUpperCase();
  if (code === 'NPB') {
    return [
      `"${name}"${team} (手術 OR 負傷 OR 離脱 OR 復帰 OR 登板回避 OR IL)`,
      `"${name}"${team} (肩 OR 肘 OR 負荷)`,
    ];
  }
  if (code === 'KBO') {
    return [
      `"${name}"${team} (부상 OR 수술 OR IL OR 복귀)`,
      `"${name}"${team} (어깨 OR 팔꿈치)`,
    ];
  }
  return [
    `"${name}"${team} (injury OR IL OR surgery OR shoulder OR elbow OR "disabled list" OR Tommy OR UCL OR scratch)`,
    `"${name}"${team} ("return from" OR activated OR rehab OR workload OR opener)`,
  ];
}

function rssLocale(league) {
  const code = String(league || '').toUpperCase();
  if (code === 'NPB') return { hl: 'ja', gl: 'JP', ceid: 'JP:ja' };
  if (code === 'KBO') return { hl: 'ko', gl: 'KR', ceid: 'KR:ko' };
  return { hl: 'en-US', gl: 'US', ceid: 'US:en' };
}

async function fetchRss(query, league) {
  const locale = rssLocale(league);
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', locale.hl);
  url.searchParams.set('gl', locale.gl);
  url.searchParams.set('ceid', locale.ceid);
  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'baseball-analytics-research/1.0',
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
  });
  if (!response.ok) {
    throw new Error(`google_news_rss_${response.status}`);
  }
  return response.text();
}

/**
 * @returns {Promise<{ok:boolean, materials:Array, queries:string[], error?:string}>}
 */
export async function searchPitcherNewsMaterials({
  pitcherName,
  teamName = null,
  league = null,
  limit = 6,
} = {}) {
  const queries = buildQueries({ pitcherName, teamName, league });
  if (!queries.length) {
    return { ok: false, materials: [], queries: [], error: 'pitcher_name_missing' };
  }
  const seen = new Set();
  const collected = [];
  const errors = [];
  for (const query of queries) {
    try {
      const xml = await fetchRss(query, league);
      const items = parseGoogleNewsRss(xml, { limit: Math.max(8, limit * 2) });
      for (const item of items) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        collected.push({ ...item, query });
      }
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
  const materials = rankAndFilterMaterials(collected, limit);
  return {
    ok: materials.length > 0,
    materials,
    queries,
    error: materials.length ? null : (errors[0] || 'no_news_materials'),
  };
}
