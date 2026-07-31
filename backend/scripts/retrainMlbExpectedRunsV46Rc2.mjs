/**
 * v4.6-rc2 消融：連續值表達（daysSinceIlExit / season_gs）
 *
 * 用法: node scripts/retrainMlbExpectedRunsV46Rc2.mjs [--persist]
 * 產物: tmp-v46-rc2-ablation.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMlbExpectedRunsV46Rc2Ablation } from '../src/services/MlbExpectedRunsModel.js';

const persist = process.argv.includes('--persist');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '../tmp-v46-rc2-ablation.json');

console.log('Running v4.6-rc2 ablation… persist=', persist);
const run = runMlbExpectedRunsV46Rc2Ablation({ persist });
const s = run.summary;

const out = {
  runId: run.runId,
  modelVersion: run.modelVersion,
  selectedKey: s.selectedKey,
  modelGate: s.modelGate,
  encoding: s.encoding,
  identityFlagRates: s.identityFlagRates,
  split: s.split,
  candidates: s.candidates,
  modelsByKey: run.modelsByKey,
  selectedModel: run.model,
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  runId: out.runId,
  selectedKey: out.selectedKey,
  modelGate: out.modelGate,
  encoding: out.encoding,
  identityFlagRates: out.identityFlagRates,
  candidates: out.candidates.map((c) => ({
    key: c.key,
    selectedByProtocol: c.selectedByProtocol,
    valBrier: c.validation.moneylineBrier,
    valMae: c.validation.totalRunsMae,
    obs2026Brier: c.observed2026.moneylineBrier,
    obs2026Mae: c.observed2026.totalRunsMae,
    temperature: c.temperature,
  })),
  wrote: outPath,
}, null, 2));
