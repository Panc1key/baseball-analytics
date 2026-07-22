import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKboInnings,
  parseKboPitcherDetailHtml,
  parseKboGameListPayload,
  matchKboPitchersToGame,
} from '../src/services/KboPitcherService.js';
import { projectNpbFamilyRuns } from '../src/services/NpbScoreModel.js';
import { pitcherRunSuppression } from '../src/services/PitcherQuality.js';

const FIXTURE_HTML = `
<table>
  <tr><th>팀명</th><th>ERA</th><th>G</th><th>W</th><th>L</th><th>IP</th><th>H</th></tr>
  <tr><td>한화</td><td>2.67</td><td>15</td><td>8</td><td>2</td><td>87 2/3</td><td>82</td></tr>
</table>
<table>
  <tr><th>BB</th><th>SO</th><th>WHIP</th><th>AVG</th></tr>
  <tr><td>11</td><td>70</td><td>1.06</td><td>0.248</td></tr>
</table>
<table>
  <tr><th>일자</th><th>상대</th><th>ERA</th><th>IP</th></tr>
  <tr><td>합계</td><td></td><td>2.18</td><td>57 2/3</td></tr>
</table>
`;

test('parseKboInnings 支援 87 2/3', () => {
  assert.ok(Math.abs(parseKboInnings('87 2/3') - (87 + 2 / 3)) < 1e-9);
  assert.equal(parseKboInnings('6'), 6);
});

test('parseKboPitcherDetailHtml 取賽季 ERA/WHIP（略過逐場表）', () => {
  const stats = parseKboPitcherDetailHtml(FIXTURE_HTML);
  assert.ok(stats);
  assert.equal(stats.era, 2.67);
  assert.equal(stats.whip, 1.06);
  assert.ok(Math.abs(stats.inningsPitched - (87 + 2 / 3)) < 1e-9);
  assert.equal(stats.wins, 8);
  assert.equal(stats.strikeOuts, 70);
});

test('parseKboGameListPayload 映射韓文隊名與先發 ID', () => {
  const rows = parseKboGameListPayload({
    game: [
      {
        G_ID: '20260719WOHH0',
        G_DT: '20260719',
        AWAY_ID: 'WO',
        HOME_ID: 'HH',
        AWAY_NM: '키움',
        HOME_NM: '한화',
        T_PIT_P_ID: 56318,
        T_PIT_P_NM: '박준현 ',
        B_PIT_P_ID: 76715,
        B_PIT_P_NM: '류현진 ',
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].homeTeamEn, 'Hanwha Eagles');
  assert.equal(rows[0].awayTeamEn, 'Kiwoom Heroes');
  assert.equal(rows[0].home.id, 76715);
  assert.equal(rows[0].home.nameKo, '류현진');
  assert.equal(rows[0].away.id, 56318);

  const hit = matchKboPitchersToGame('Hanwha Eagles', 'Kiwoom Heroes', rows);
  assert.ok(hit);
  assert.equal(hit.home.id, 76715);
});

test('王牌 vs 軟先發：主隊預期失分（客λ）明顯下降', () => {
  const baseStats = {
    team_name: 'Hanwha Eagles',
    wins: 40,
    losses: 42,
    runs_scored: 380,
    runs_allowed: 390,
    rating: 0.5,
  };
  const awayStats = {
    team_name: 'Kiwoom Heroes',
    wins: 31,
    losses: 57,
    runs_scored: 320,
    runs_allowed: 420,
    rating: 0.4,
  };

  const ace = { era: 2.67, whip: 1.06 };
  const soft = { era: 5.1, whip: 1.55 };

  const withAce = projectNpbFamilyRuns({
    league: 'KBO',
    homeTeam: 'Hanwha Eagles',
    awayTeam: 'Kiwoom Heroes',
    homeTeamStats: baseStats,
    awayTeamStats: awayStats,
    homeGames: 82,
    awayGames: 88,
    homePitcherStats: ace,
    awayPitcherStats: soft,
    homePitcherName: '류현진',
    awayPitcherName: '박준현',
  });

  const withSoftHome = projectNpbFamilyRuns({
    league: 'KBO',
    homeTeam: 'Hanwha Eagles',
    awayTeam: 'Kiwoom Heroes',
    homeTeamStats: baseStats,
    awayTeamStats: awayStats,
    homeGames: 82,
    awayGames: 88,
    homePitcherStats: soft,
    awayPitcherStats: ace,
    homePitcherName: 'Hernandez',
    awayPitcherName: 'An',
  });

  // 主場王牌：客隊得分 λ 應低於「主場軟投、客場王牌」
  assert.ok(
    withAce.awayRuns < withSoftHome.awayRuns - 0.15,
    `ace awayλ=${withAce.awayRuns} vs softHome awayλ=${withSoftHome.awayRuns}`
  );
  // 主場王牌日：主勝期望（得失分差）應更偏向主隊
  const aceMargin = withAce.homeRuns - withAce.awayRuns;
  const softMargin = withSoftHome.homeRuns - withSoftHome.awayRuns;
  assert.ok(aceMargin > softMargin + 0.25, `aceMargin=${aceMargin} softMargin=${softMargin}`);
  assert.ok(withAce.factors.some((f) => f.includes('先發λ')));
});

test('pitcherRunSuppression scale 縮放', () => {
  const weak = { era: 5.4, whip: 1.55 };
  const full = pitcherRunSuppression(weak, { scale: 1 });
  const half = pitcherRunSuppression(weak, { scale: 0.5 });
  assert.ok(full > 0.2);
  assert.ok(Math.abs(half - full * 0.5) < 1e-9);
});
