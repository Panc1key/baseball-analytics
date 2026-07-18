/**
 * NPB 即時比分 — The Odds API 對 baseball_npb 常回傳 scores:null
 * 改從 Yahoo スポーツナビ日程頁解析（免費、無需 key）
 * https://baseball.yahoo.co.jp/npb/schedule/
 */

const YAHOO_NPB_SCHEDULE = 'https://baseball.yahoo.co.jp/npb/schedule/';

/** 日文簡稱 → Odds API 英文隊名（Yahoo / baseball-data 共用） */
export const NPB_JA_TO_EN = {
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

export function mapNpbTeamJaToEn(jaName) {
  const n = stripTags(jaName);
  if (NPB_JA_TO_EN[n]) return NPB_JA_TO_EN[n];
  for (const [ja, en] of Object.entries(NPB_JA_TO_EN)) {
    if (n.includes(ja)) return en;
  }
  return null;
}

/** @deprecated 使用 mapNpbTeamJaToEn */
function mapTeam(jaName) {
  return mapNpbTeamJaToEn(jaName);
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
export async function fetchYahooNpbLiveScores(dateIso = null) {
  const url = dateIso
    ? `${YAHOO_NPB_SCHEDULE}?date=${dateIso}`
    : YAHOO_NPB_SCHEDULE;
  const res = await fetch(url, {
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

const YAHOO_NPB_STANDINGS = 'https://baseball.yahoo.co.jp/npb/standings/';

/**
 * Yahoo 順位表（中央＋太平洋）：勝敗、得失分、勝率
 * 這是 NPB 初盤隊力的主數據源（Odds API scores 常為 null）
 */
export async function fetchYahooNpbStandings() {
  const res = await fetch(YAHOO_NPB_STANDINGS, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`Yahoo NPB standings HTTP ${res.status}`);
  const html = await res.text();
  return parseYahooNpbStandingsHtml(html);
}

export function parseYahooNpbStandingsHtml(html) {
  // 只取正式球季表頭（避開導航列的「セ・リーグ」文字）
  const findSection = (label) => {
    const needle = `bb-rankHead__title">${label}`;
    return html.indexOf(needle);
  };
  const centralStart = findSection('セ・リーグ');
  const pacificStart = findSection('パ・リーグ');
  const interStart = findSection('交流戦');

  const chunks = [];
  if (centralStart >= 0 && pacificStart > centralStart) {
    chunks.push(html.slice(centralStart, pacificStart));
  }
  if (pacificStart >= 0) {
    const end = interStart > pacificStart ? interStart : pacificStart + 100000;
    chunks.push(html.slice(pacificStart, end));
  }
  if (!chunks.length) chunks.push(html);

  const byTeam = new Map();
  for (const chunk of chunks) {
    const rowRe = /<tr class="bb-rankTable__row">([\s\S]*?)<\/tr>/g;
    let match;
    while ((match = rowRe.exec(chunk)) !== null) {
      const block = match[1];
      const teamJa = stripTags(block.match(/bb-rankTable__team[^>]*>([^<]+)</)?.[1]);
      const teamName = mapTeam(teamJa);
      if (!teamName) continue;

      const cells = [...block.matchAll(/<td class="bb-rankTable__data[^"]*">([\s\S]*?)<\/td>/g)].map((m) =>
        stripTags(m[1])
      );
      // 順位 | 隊名 | 試合 | 勝利 | 敗戦 | 引分 | 勝率 | 勝差 | 残試合 | 得点 | 失点 | ...
      if (cells.length < 11) continue;
      const games = parseInt(cells[2], 10);
      const wins = parseInt(cells[3], 10);
      const losses = parseInt(cells[4], 10);
      const draws = parseInt(cells[5], 10);
      const winPct = parseFloat(cells[6]);
      const runsScored = parseInt(cells[9], 10);
      const runsAllowed = parseInt(cells[10], 10);
      if (!Number.isFinite(wins) || !Number.isFinite(losses)) continue;

      // 過濾明顯非正式球季樣本（交流戦約 18 場等級）
      if (Number.isFinite(games) && games < 40) continue;

      const decisive = wins + losses;
      const rating =
        Number.isFinite(winPct) && winPct > 0
          ? winPct
          : decisive > 0
            ? wins / decisive
            : 0.5;

      const row = {
        teamName,
        teamJa,
        games: Number.isFinite(games) ? games : decisive + (draws || 0),
        wins,
        losses,
        draws: Number.isFinite(draws) ? draws : 0,
        winPct: rating,
        runsScored: Number.isFinite(runsScored) ? runsScored : null,
        runsAllowed: Number.isFinite(runsAllowed) ? runsAllowed : null,
        source: 'yahoo_npb_standings',
      };

      const prev = byTeam.get(teamName);
      if (!prev || row.games > prev.games) byTeam.set(teamName, row);
    }
  }
  return [...byTeam.values()];
}
