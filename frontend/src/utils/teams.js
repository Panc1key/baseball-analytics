/** MLB / NPB / KBO 球隊中文名（繁體） */
export const TEAM_ZH = {
  // MLB
  'Arizona Diamondbacks': '亞利桑那響尾蛇',
  Athletics: '奧克蘭運動家',
  'Oakland Athletics': '奧克蘭運動家',
  'Atlanta Braves': '亞特蘭大勇士',
  'Baltimore Orioles': '巴爾的摩金鶯',
  'Boston Red Sox': '波士頓紅襪',
  'Chicago Cubs': '芝加哥小熊',
  'Chicago White Sox': '芝加哥白襪',
  'Cincinnati Reds': '辛辛那提紅人',
  'Cleveland Guardians': '克里夫蘭守護者',
  'Cleveland Indians': '克里夫蘭守護者',
  'Colorado Rockies': '科羅拉多洛磯',
  'Detroit Tigers': '底特律老虎',
  'Houston Astros': '休士頓太空人',
  'Kansas City Royals': '堪薩斯市皇家',
  'Los Angeles Angels': '洛杉磯天使',
  'Los Angeles Dodgers': '洛杉磯道奇',
  'Miami Marlins': '邁阿密馬林魚',
  'Milwaukee Brewers': '密爾瓦基釀酒人',
  'Minnesota Twins': '明尼蘇達雙城',
  'New York Mets': '紐約大都會',
  'New York Yankees': '紐約洋基',
  'Philadelphia Phillies': '費城費城人',
  'Pittsburgh Pirates': '匹茲堡海盜',
  'San Diego Padres': '聖地牙哥教士',
  'San Francisco Giants': '舊金山巨人',
  'Seattle Mariners': '西雅圖水手',
  'St. Louis Cardinals': '聖路易紅雀',
  'Tampa Bay Rays': '坦帕灣光芒',
  'Texas Rangers': '德州遊騎兵',
  'Toronto Blue Jays': '多倫多藍鳥',
  'Washington Nationals': '華盛頓國民',

  // NPB
  'Saitama Seibu Lions': '埼玉西武獅',
  'Tohoku Rakuten Golden Eagles': '東北樂天金鷲',
  'Yomiuri Giants': '讀賣巨人',
  'Hanshin Tigers': '阪神虎',
  'Chunichi Dragons': '中日龍',
  'Hiroshima Toyo Carp': '廣島東洋鯉魚',
  'Tokyo Yakult Swallows': '東京養樂多燕子',
  'Yokohama DeNA BayStars': '橫濱 DeNA 灣星',
  'Fukuoka SoftBank Hawks': '福岡軟銀鷹',
  'Orix Buffaloes': '歐力士野牛',
  'Hokkaido Nippon-Ham Fighters': '北海道日本火腿鬥士',
  'Chiba Lotte Marines': '千葉羅德海洋',

  // KBO
  'LG Twins': 'LG 雙子',
  'Doosan Bears': '斗山熊',
  'SSG Landers': 'SSG 登陸者',
  'Kiwoom Heroes': '奇異英雄',
  'NC Dinos': 'NC 恐龍',
  'KT Wiz': 'KT 巫師',
  'Samsung Lions': '三星獅',
  'Lotte Giants': '樂天巨人',
  'Hanwha Eagles': '韓華鷹',
  'KIA Tigers': '起亞虎',
};

const BOOKMAKER_ZH = {
  pinnacle: 'Pinnacle 平博',
  draftkings: 'DraftKings',
  fanduel: 'FanDuel',
  betmgm: 'BetMGM',
  bovada: 'Bovada',
  betonlineag: 'BetOnline',
  mybookieag: 'MyBookie',
  williamhill_us: 'William Hill',
};

const LEAGUE_LABELS = {
  MLB: 'MLB 美職',
  NPB: 'NPB 日職',
  KBO: 'KBO 韓職',
};

const TEAM_NAMES_SORTED = Object.keys(TEAM_ZH).sort((a, b) => b.length - a.length);

/** 邁阿密馬林魚（Miami Marlins） */
export function formatTeamName(name) {
  if (!name) return '';
  const zh = TEAM_ZH[name];
  if (zh) return `${zh}（${name}）`;
  return name;
}

/** 客隊 @ 主隊 */
export function formatMatchup(awayTeam, homeTeam) {
  return `${formatTeamName(awayTeam)} @ ${formatTeamName(homeTeam)}`;
}

export function leagueLabel(league) {
  return LEAGUE_LABELS[league] || league;
}

export function bookmakerLabel(name) {
  if (!name) return '';
  const key = String(name).toLowerCase().replace(/\s+/g, '');
  for (const [k, label] of Object.entries(BOOKMAKER_ZH)) {
    if (key.includes(k.replace(/_/g, ''))) return label;
  }
  return name;
}

/** 將字串中的英文隊名替換為中文（含括號英文） */
export function translatePick(text) {
  if (!text) return '';
  let result = String(text);
  for (const en of TEAM_NAMES_SORTED) {
    if (result.includes(en)) {
      result = result.split(en).join(formatTeamName(en));
    }
  }
  return result;
}

/** 分析說明：隊名中文化 */
export function translateReasoning(text) {
  return translatePick(text);
}
