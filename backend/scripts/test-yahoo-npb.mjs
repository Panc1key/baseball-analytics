import { fetchYahooNpbLiveScores, parseYahooNpbScheduleHtml } from '../src/services/NpbYahooScores.js';
import fs from 'fs';

const fromFile = fs.existsSync('tmp-npb-yahoo.html');
const list = fromFile
  ? parseYahooNpbScheduleHtml(fs.readFileSync('tmp-npb-yahoo.html', 'utf8'))
  : await fetchYahooNpbLiveScores();

console.log('yahoo games', list.length);
for (const g of list) {
  console.log(
    `${g.awayTeam} @ ${g.homeTeam} | ${g.awayScore}-${g.homeScore} | ${g.status} | ${g.inningLabel} | src=${g.linescore?.source}`
  );
}
