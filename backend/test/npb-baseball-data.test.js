import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBaseballDataTeamHitting,
  parseBaseballDataTeamPitching,
} from '../src/services/NpbBaseballDataStats.js';

const HIT_HTML = `
<table id="tbl-ce" class="tablesorter stats"><thead><tr>
<th>順位</th><th>チーム</th><th>試合</th><th>勝利</th><th>敗北</th><th>引分</th>
<th>打率</th><th>得点</th><th>安打</th><th>本塁打</th><th>盗塁</th><th>犠打</th>
<th>四球</th><th>死球</th><th>三振</th><th>併殺打</th>
<th>出塁率</th><th>長打率</th><th>OPS</th><th>a</th><th>b</th><th>c</th><th>d</th><th>e</th>
</tr></thead><tbody>
<tr><td>1</td><td>阪神</td><td>83</td><td>46</td><td>36</td><td>1</td>
<td>.246</td><td>300</td><td>700</td><td>80</td><td>40</td><td>50</td>
<td>200</td><td>20</td><td>500</td><td>40</td>
<td>.317</td><td>.373</td><td>.691</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
</tbody></table>
<table id="tbl-pa" class="tablesorter stats"><thead><tr>
<th>順位</th><th>チーム</th><th>試合</th><th>勝利</th><th>敗北</th><th>引分</th>
<th>打率</th><th>得点</th><th>安打</th><th>本塁打</th><th>盗塁</th><th>犠打</th>
<th>四球</th><th>死球</th><th>三振</th><th>併殺打</th>
<th>出塁率</th><th>長打率</th><th>OPS</th><th>a</th><th>b</th><th>c</th><th>d</th><th>e</th>
</tr></thead><tbody>
<tr><td>1</td><td>ソフトバンク</td><td>84</td><td>51</td><td>32</td><td>1</td>
<td>.250</td><td>320</td><td>720</td><td>90</td><td>50</td><td>40</td>
<td>220</td><td>15</td><td>480</td><td>35</td>
<td>.326</td><td>.399</td><td>.725</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>
</tbody></table>
`;

const PIT_HTML = `
<table id="tbl-ce" class="tablesorter stats"><tbody>
<tr><td>1</td><td>阪神</td><td>83</td><td>46</td><td>36</td><td>1</td>
<td>2.94</td><td>10</td><td>20</td><td>5</td><td>2</td><td>600</td><td>50</td>
<td>200</td><td>20</td><td>500</td><td>240</td><td>220</td><td>1.14</td><td>3.22</td><td>3.14</td><td>7.78</td></tr>
</tbody></table>
`;

describe('NpbBaseballDataStats parser', () => {
  it('解析隊級 OPS 並對應英文隊名', () => {
    const rows = parseBaseballDataTeamHitting(HIT_HTML);
    assert.equal(rows.length, 2);
    const hanshin = rows.find((r) => r.teamName === 'Hanshin Tigers');
    assert.ok(hanshin);
    assert.equal(hanshin.ops, 0.691);
    assert.equal(hanshin.obp, 0.317);
    const hawks = rows.find((r) => r.teamName === 'Fukuoka SoftBank Hawks');
    assert.equal(hawks.ops, 0.725);
  });

  it('解析隊級 ERA/WHIP', () => {
    const rows = parseBaseballDataTeamPitching(PIT_HTML);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].teamName, 'Hanshin Tigers');
    assert.equal(rows[0].era, 2.94);
    assert.equal(rows[0].whip, 1.14);
  });
});
