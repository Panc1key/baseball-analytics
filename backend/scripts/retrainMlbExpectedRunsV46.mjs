/**
 * v4.6-rc 消融重訓（不升格正式、預設不寫庫）
 *
 * 用法: node scripts/retrainMlbExpectedRunsV46.mjs [--persist]
 * 產物: tmp-v46-rc-ablation.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMlbExpectedRunsV46RcAblation } from '../src/services/MlbExpectedRunsModel.js';

const persist = process.argv.includes('--persist');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '../tmp-v46-rc-ablation.json');

console.log('Running v4.6-rc ablation… persist=', persist);
const run = runMlbExpectedRunsV46RcAblation({ persist });
const s = run.summary;

const out = {
  runId: run.runId,
  modelVersion: run.modelVersion,
  selectedKey: s.selectedKey,
  modelGate: s.modelGate,
  identityFlagRates: s.identityFlagRates,
  sparseStart: s.sparseStart,
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
