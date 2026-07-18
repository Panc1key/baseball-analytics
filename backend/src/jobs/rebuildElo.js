/**
 * 重建 NPB/KBO 滾動 Elo
 * 用法: node src/jobs/rebuildElo.js
 */
import { rebuildAllBaseballElo } from '../services/BaseballElo.js';

const result = rebuildAllBaseballElo();
console.log(JSON.stringify(result, null, 2));
