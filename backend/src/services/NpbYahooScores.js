/**
 * NPB 即時比分 — The Odds API 對 baseball_npb 常回傳 scores:null
 * 改從 Yahoo スポーツナビ日程頁解析（免費、無需 key）
 * https://baseball.yahoo.co.jp/npb/schedule/
 */

const YAHOO_NPB_SCHEDULE = 'https://baseball.yahoo.co.jp/npb/schedule/';

/** Yahoo 簡稱 → Odds API 英文隊名 */
const NPB_JA_TO_EN = {
  巨人: 'Yomiuri Giants',
  ヤクルト: 'Tokyo Yakult Swallows',
  阪神: 'Hanshin Tigers',
  中日: 'Chunichi Dragons',
  広島: 'Hiroshima Toyo Carp',
  DeNA: 'Yokohama DeNA BayStars',
  横浜: 'Yokohama DeNA BayStars',
  西武: 'Saitama Seibu Lions',
  ロッテ: 'Chiba Lotte Marines',
  ソフトバンク: 'Fukuoka SoftBank Hawks',
  日本ハム: 'Hokkaido Nippon-Ham Fighters',
  日ハム: 'Hokkaido Nippon-Ham Fighters',
  オリックス: 'Orix Buffaloes',
  楽天: 'Tohoku Rakuten Golden Eagles',
};

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function mapTeam(jaName) {
  const n = stripTags(jaName);
  if (NPB_JA_TO_EN[n]) return NPB_JA_TO_EN[n];
  for (const [ja, en] of Object.entries(NPB_JA_TO_EN)) {
    if (n.includes(ja)) return en;
  }
  return null;
}

/**
 * 解析「5回裏」「6回表」「試合終了」→ linescore 相容結構
 */
export function parseNpbInningLabel(label) {
  const t = stripTags(label);
  if (!t) return null;
  if (/終了|中止|キャンセル|延期/.test(t)) {
    return {
      completed: /終了/.test(t),
      cancelled: /中止|キャンセル|延期/.test(t),
      inningsPlayed: 9,
      inningsRemaining: 0,
      currentInning: 9,
      inningState: 'End',
      label: t,
      source: 'yahoo_npb',
    };
  }

  const m = t.match(/(\d+)\s*回\s*(表|裏)?/);
  if (!m) {
    if (/試合前|開始前|予告/.test(t)) {
      return {
        completed: false,
        inningsPlayed: 0,
        inningsRemaining: 9,
        currentInning: 0,
        inningState: null,
        label: t,
        source: 'yahoo_npb',
      };
    }
    return { completed: false, label: t, source: 'yahoo_npb' };
  }

  const currentInning = parseInt(m[1], 10);
  const half = m[2] === '裏' ? 'Bottom' : m[2] === '表' ? 'Top' : 'Middle';
  let inningsPlayed;
  if (half === 'Bottom') inningsPlayed = currentInning - 0.25;
  else if (half === 'Top') inningsPlayed = currentInning - 0.75;
  else inningsPlayed = currentInning - 0.5;

  const inningsRemaining = Math.max(0.3, 9 - inningsPlayed);
  return {
    completed: false,
    inningsPlayed: Math.round(inningsPlayed * 100) / 100,
    inningsRemaining: Math.round(inningsRemaining * 100) / 100,
    currentInning,
    inningState: half,
    outs: null,
    label: t,
    source: 'yahoo_npb',
  };
}

/**
 * @returns {Promise<Array<{
 *   homeTeam, awayTeam, homeScore, awayScore, status, inningLabel, linescore, gameUrl, source
 * }>>}
 */
export async function fetchYahooNpbLiveScores() {
  const res = await fetch(YAHOO_NPB_SCHEDULE, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`Yahoo NPB schedule HTTP ${res.status}`);
  const html = await res.text();
  return parseYahooNpbScheduleHtml(html);
}

export function parseYahooNpbScheduleHtml(html) {
  const results = [];
  const itemRe = /<li class="bb-score__item([^"]*)">([\s\S]*?)<\/li>/g;
  let match;
  while ((match = itemRe.exec(html)) !== null) {
    const itemClass = match[1] || '';
    const block = match[2];
    const homeJa = block.match(/bb-score__homeLogo[^>]*>([^<]+)</)?.[1];
    const awayJa = block.match(/bb-score__awayLogo[^>]*>([^<]+)</)?.[1];
    const left = block.match(/bb-score__score--left[^>]*>([^<]*)</)?.[1];
    const right = block.match(/bb-score__score--right[^>]*>([^<]*)</)?.[1];
    const link = stripTags(block.match(/bb-score__link[^>]*>([\s\S]*?)<\/p>/)?.[1]);
    const href = block.match(/href="(\/npb\/game\/\d+\/[^"]*)"/)?.[1];

    const homeTeam = mapTeam(homeJa);
    const awayTeam = mapTeam(awayJa);
    if (!homeTeam || !awayTeam) continue;

    const homeScore =
      left != null && String(left).trim() !== '' ? parseInt(String(left).trim(), 10) : null;
    const awayScore =
      right != null && String(right).trim() !== '' ? parseInt(String(right).trim(), 10) : null;

    const linescore = parseNpbInningLabel(link);
    const isLive = itemClass.includes('bb-score__item--live');
    const completed = Boolean(linescore?.completed) || /終了/.test(link || '');

    results.push({
      homeTeam,
      awayTeam,
      homeScore: Number.isFinite(homeScore) ? homeScore : null,
      awayScore: Number.isFinite(awayScore) ? awayScore : null,
      status: completed ? 'completed' : isLive || linescore?.currentInning ? 'in_progress' : 'scheduled',
      inningLabel: link || null,
      linescore:
        linescore && Number.isFinite(homeScore) && Number.isFinite(awayScore)
          ? {
              ...linescore,
              homeScore,
              awayScore,
            }
          : linescore,
      gameUrl: href ? `https://baseball.yahoo.co.jp${href}` : null,
      source: 'yahoo_npb',
    });
  }
  return results;
}

function normalizeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** 把 Yahoo 比分對應到 DB 裡的 NPB 場次 */
export function matchYahooScoreToGame(game, yahooScores) {
  const home = normalizeKey(game.home_team);
  const away = normalizeKey(game.away_team);
  return (yahooScores || []).find((y) => {
    const yh = normalizeKey(y.homeTeam);
    const ya = normalizeKey(y.awayTeam);
    return (
      (yh.includes(home) || home.includes(yh) || yh === home) &&
      (ya.includes(away) || away.includes(ya) || ya === away)
    );
  });
}
