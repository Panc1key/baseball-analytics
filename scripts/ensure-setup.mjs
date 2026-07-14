import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const envPath = path.join(root, 'backend', '.env');
const examplePath = path.join(root, 'backend', '.env.example');

function parseEnv(content) {
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    vars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return vars;
}

if (!fs.existsSync(envPath)) {
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    console.log('[setup] 已從 .env.example 建立 backend/.env，請填入 API Key');
  } else {
    console.warn('[setup] 找不到 backend/.env，請手動建立');
  }
}

if (fs.existsSync(envPath)) {
  const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
  const missing = [];
  if (!env.ODDS_API_KEY || env.ODDS_API_KEY === 'your_api_key_here') {
    missing.push('ODDS_API_KEY');
  }
  if (!env.API_FOOTBALL_KEY) {
    missing.push('API_FOOTBALL_KEY（可選，用於陣容/戰術）');
  }
  if (missing.length) {
    console.warn(`[setup] 尚未設定: ${missing.join(', ')}`);
  } else {
    console.log('[setup] API Key 已就緒 · 棒球 + 世界盃');
  }
}

console.log('[setup] 啟動後訪問: http://localhost:5175');
console.log('[setup] 後端 API: http://localhost:3101');
