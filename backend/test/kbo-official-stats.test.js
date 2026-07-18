import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKboOfficialTeamStats } from '../src/services/KboOfficialStats.js';

const FIXTURE = `
<table><tr>
<th>TEAM</th><th>BB</th><th>IBB</th><th>HBP</th><th>SO</th><th>GIDP</th>
<th>SLG</th><th>OBP</th><th>E</th><th>SBPCT</th><th>BB/K</th><th>XBH/H</th><th>MH</th>
<th>OPS</th><th>RISP</th><th>PH</th>
</tr>
<tr><td>KT</td><td>352</td><td>6</td><td>43</td><td>638</td><td>64</td>
<td>0.397</td><td>0.364</td><td>48</td><td>0.581</td><td>1.81</td><td>0.256</td><td>85</td>
<td>0.761</td><td>0.293</td><td>0.303</td></tr>
<tr><td>HANWHA</td><td>300</td><td>1</td><td>1</td><td>1</td><td>1</td>
<td>0.428</td><td>0.352</td><td>1</td><td>0.7</td><td>1</td><td>0.3</td><td>80</td>
<td>0.780</td><td>0.27</td><td>0.2</td></tr>
</table>
<table><tr>
<th>TEAM</th><th>ERA</th><th>G</th><th>CG</th><th>SHO</th><th>W</th><th>L</th>
<th>SV</th><th>HLD</th><th>PCT</th><th>PA</th><th>NP</th><th>IP</th><th>H</th><th>2B</th><th>3B</th><th>HR</th>
</tr>
<tr><td>KT</td><td>4.80</td><td>85</td><td>0</td><td>0</td><td>40</td><td>40</td>
<td>10</td><td>10</td><td>0.5</td><td>3000</td><td>10000</td><td>700</td><td>700</td><td>100</td><td>10</td><td>80</td></tr>
</table>
<table><tr>
<th>TEAM</th><th>SAC</th><th>SF</th><th>BB</th><th>IBB</th><th>HBP</th><th>SO</th>
<th>WP</th><th>BK</th><th>R</th><th>ER</th><th>BS</th><th>WHIP</th><th>OAVG</th><th>QS</th>
</tr>
<tr><td>KT</td><td>30</td><td>20</td><td>250</td><td>5</td><td>40</td><td>500</td>
<td>20</td><td>0</td><td>400</td><td>360</td><td>10</td><td>1.46</td><td>0.280</td><td>30</td></tr>
<tr><td>HANWHA</td><td>30</td><td>20</td><td>250</td><td>5</td><td>40</td><td>500</td>
<td>20</td><td>0</td><td>400</td><td>360</td><td>10</td><td>1.51</td><td>0.270</td><td>25</td></tr>
</table>
`;

describe('KboOfficialStats parser', () => {
  it('解析 OPS/ERA/WHIP 並對應 Odds 英文隊名', () => {
    const { hitting, pitching } = parseKboOfficialTeamStats(FIXTURE);
    assert.equal(hitting.length, 2);
    const ktHit = hitting.find((h) => h.teamName === 'KT Wiz');
    assert.ok(ktHit);
    assert.equal(ktHit.ops, 0.761);
    assert.equal(ktHit.obp, 0.364);
    const hh = hitting.find((h) => h.teamName === 'Hanwha Eagles');
    assert.equal(hh.ops, 0.78);

    const ktPit = pitching.find((p) => p.teamName === 'KT Wiz');
    assert.equal(ktPit.era, 4.8);
    assert.equal(ktPit.whip, 1.46);
    const hhPit = pitching.find((p) => p.teamName === 'Hanwha Eagles');
    assert.equal(hhPit.whip, 1.51);
  });
});
