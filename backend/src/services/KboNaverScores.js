/**
 * KBO 比分 — Odds API scores 常為 null
 * 用 Naver Sports gateway（免費、無需 key）
 */
const NAVER_GAMES =
  'https://api-gw.sports.naver.com/schedule/games';

/** Naver／KBO 官網代碼 → Odds API 英文隊名 */
export const KBO_TO_EN = {
  두산: 'Doosan Bears',
  DOOSAN: 'Doosan Bears',
  OB: 'Doosan Bears',
  NC: 'NC Dinos',
  엔씨: 'NC Dinos',
  키움: 'Kiwoom Heroes',
  KIWOOM: 'Kiwoom Heroes',
  WO: 'Kiwoom Heroes',
  한화: 'Hanwha Eagles',
  HANWHA: 'Hanwha Eagles',
  HH: 'Hanwha Eagles',
  KT: 'KT Wiz',
  케이티: 'KT Wiz',
  LG: 'LG Twins',
  엘지: 'LG Twins',
  KIA: 'Kia Tigers',
  기아: 'Kia Tigers',
  HT: 'Kia Tigers',
  SSG: 'SSG Landers',
  SK: 'SSG Landers',
  롯데: 'Lotte Giants',
  LOTTE: 'Lotte Giants',
  LT: 'Lotte Giants',
  삼성: 'Samsung Lions',
  SAMSUNG: 'Samsung Lions',
  SS: 'Samsung Lions',
};

export function mapKboTeamToEn(nameOrCode) {
  const raw = String(nameOrCode || '').trim();
  if (!raw) return null;
  if (KBO_TO_EN[raw]) return KBO_TO_EN[raw];
  const upper = raw.toUpperCase();
  if (KBO_TO_EN[upper]) return KBO_TO_EN[upper];
  for (const [k, en] of Object.entries(KBO_TO_EN)) {
    if (raw.includes(k) || upper.includes(k.toUpperCase())) return en;
  }
  return null;
}

function mapTeam(nameOrCode) {
  return mapKboTeamToEn(nameOrCode);
}

function normalizeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * @param {string} dateIso YYYY-MM-DD
 */
export async function fetchNaverKboScores(dateIso) {
  const url = new URL(NAVER_GAMES);
  url.searchParams.set('fields', 'basic,schedule');
  url.searchParams.set('upperCategoryId', 'kbaseball');
  url.searchParams.set('categoryIds', 'kbo');
  url.searchParams.set('fromDate', dateIso);
  url.searchParams.set('toDate', dateIso);
  url.searchParams.set('size', '50');

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: 'https://m.sports.naver.com/',
    },
  });
  if (!res.ok) throw new Error(`Naver KBO HTTP ${res.status}`);
  const json = await res.json();
  const games = json?.result?.games || [];

  return games
    .map((g) => {
      const homeTeam = mapTeam(g.homeTeamName) || mapTeam(g.homeTeamCode);
      const awayTeam = mapTeam(g.awayTeamName) || mapTeam(g.awayTeamCode);
      const homeScore = Number(g.homeTeamScore);
      const awayScore = Number(g.awayTeamScore);
      const statusCode = String(g.statusCode || g.statusInfo || '');
      const completed =
        /RESULT|ENDED|FINAL|종료/i.test(statusCode) ||
        g.winner === 'HOME' ||
        g.winner === 'AWAY' ||
        g.winner === 'DRAW';

      if (!homeTeam || !awayTeam) return null;
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;

      return {
        homeTeam,
        awayTeam,
        homeScore,
        awayScore,
        completed,
        statusCode,
        gameDate: g.gameDate,
        source: 'naver_kbo',
      };
    })
    .filter(Boolean);
}

export function matchKboScoreToGame(game, scores) {
  const home = normalizeKey(game.home_team);
  const away = normalizeKey(game.away_team);
  return (scores || []).find((y) => {
    const yh = normalizeKey(y.homeTeam);
    const ya = normalizeKey(y.awayTeam);
    return (
      (yh === home || yh.includes(home) || home.includes(yh)) &&
      (ya === away || ya.includes(away) || away.includes(ya))
    );
  });
}
