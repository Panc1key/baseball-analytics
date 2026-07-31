/**
 * DeepSeek 投手傷病情報完整試跑：真實 Google News RSS + 結構化旗標。
 *
 *   $env:DEEPSEEK_API_KEY="..."; node scripts/trialDeepseekPitcherFlags.mjs
 *   node scripts/trialDeepseekPitcherFlags.mjs --name="Shohei Ohtani" --league=MLB
 */
import { config } from '../src/config.js';
import {
  analyzePitcherInjuryIntel,
  isDeepseekConfigured,
} from '../src/services/PitcherInjuryIntelService.js';

function argValue(flag) {
  const hit = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}

if (!isDeepseekConfigured()) {
  console.error(JSON.stringify({
    ok: false,
    error: 'deepseek_api_key_missing',
    hint: '請設定 DEEPSEEK_API_KEY（backend/.env 或環境變數）',
  }, null, 2));
  process.exit(1);
}

const cases = [];
const name = argValue('--name');
if (name) {
  cases.push({
    key: 'cli',
    pitcherName: name,
    teamName: argValue('--team'),
    league: argValue('--league') || 'MLB',
    commenceTime: new Date().toISOString(),
    force: true,
  });
} else {
  cases.push(
    {
      key: 'mlb_ohtani',
      pitcherName: 'Shohei Ohtani',
      teamName: 'Los Angeles Dodgers',
      league: 'MLB',
      commenceTime: new Date().toISOString(),
      force: true,
    },
    {
      key: 'npb_hayakawa',
      pitcherName: '早川隆久',
      teamName: '楽天',
      league: 'NPB',
      commenceTime: new Date().toISOString(),
      force: true,
    }
  );
}

const results = [];
for (const item of cases) {
  const started = Date.now();
  const output = await analyzePitcherInjuryIntel(item);
  results.push({
    key: item.key,
    ms: Date.now() - started,
    ok: output.ok,
    status: output.status,
    error: output.error || null,
    materialsCount: output.materials?.length || 0,
    sampleTitles: (output.materials || []).slice(0, 3).map((m) => m.title),
    result: output.result,
    model: output.model,
    usage: output.usage || null,
  });
}

console.log(JSON.stringify({
  ok: results.every((row) => row.ok),
  modelConfig: config.deepseekModel,
  note: '完整管線試跑：RSS 檢索 + DeepSeek 旗標；未改模型權重。',
  results,
}, null, 2));
