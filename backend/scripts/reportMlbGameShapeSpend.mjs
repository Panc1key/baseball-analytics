/**
 * 汇总形态标注 DeepSeek 花费（按 batch 去重，避免同批 usage 重复计入）
 *   node scripts/reportMlbGameShapeSpend.mjs
 */
import fs from 'fs';
import db from '../src/db/database.js';

const FLASH_IN = 1; // 元 / 百万 input（cache miss 粗估）
const FLASH_OUT = 2; // 元 / 百万 output

const rows = db
  .prepare(
    `SELECT fetched_at, usage_json, model, status
     FROM mlb_game_shape_llm_cache
     WHERE usage_json IS NOT NULL`
  )
  .all();

const seen = new Set();
let prompt = 0;
let completion = 0;
let batches = 0;
for (const r of rows) {
  let u;
  try {
    u = JSON.parse(r.usage_json);
  } catch {
    continue;
  }
  const key = `${r.fetched_at}|${u.prompt_tokens}|${u.completion_tokens}|${u.total_tokens}`;
  if (seen.has(key)) continue;
  seen.add(key);
  batches += 1;
  prompt += u.prompt_tokens || 0;
  completion += u.completion_tokens || 0;
}

const estRmb = (prompt / 1e6) * FLASH_IN + (completion / 1e6) * FLASH_OUT;
const cacheOk = db
  .prepare(`SELECT COUNT(*) AS n FROM mlb_game_shape_llm_cache WHERE status = 'ok'`)
  .get().n;

const spendFile = new URL('../tmp-game-shape-spend.json', import.meta.url);
let fileSpend = null;
try {
  fileSpend = JSON.parse(fs.readFileSync(spendFile, 'utf8'));
} catch {
  fileSpend = null;
}

const out = {
  cacheOk,
  uniqueBatches: batches,
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  estRmbFlash: Number(estRmb.toFixed(4)),
  hit100Rmb: estRmb >= 100,
  remainingTo100Rmb: Number(Math.max(0, 100 - estRmb).toFixed(4)),
  fileSpend,
  note: '按 Flash 粗估：输入1元/百万 + 输出2元/百万（未计缓存命中折扣）',
};

console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(
  new URL('../tmp-game-shape-spend-report.json', import.meta.url),
  JSON.stringify(out, null, 2)
);
