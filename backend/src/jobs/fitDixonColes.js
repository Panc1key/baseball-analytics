/**
 * 擬合 NPB/KBO Dixon–Coles ρ，寫入 data/dixon-coles.json
 * 用法: node src/jobs/fitDixonColes.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fitAllDixonColesRho } from '../models/DixonColes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../../data/dixon-coles.json');

const result = fitAllDixonColesRho();
const out = {
  ...result,
  fittedAt: new Date().toISOString(),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
console.log('已寫入', OUT);
