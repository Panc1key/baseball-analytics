/**
 * 用法：
 * node scripts/importCollectorSnapshots.mjs ../collector/exports/sofascore-15506787-prematch.json --game-id <odds-api-game-id>
 *
 * 這是人工審核後的單向匯入；不會執行 Python、瀏覽器或外部抓取。
 */
import { importCollectorPrematchSnapshots } from '../src/services/ExternalPrematchSnapshotService.js';

const filePath = process.argv[2];
const gameIdFlag = process.argv.indexOf('--game-id');
const gameId = gameIdFlag >= 0 ? process.argv[gameIdFlag + 1] : null;
if (!filePath) {
  console.error('用法：node scripts/importCollectorSnapshots.mjs <collector-prematch-export.json> [--game-id <odds-api-game-id>]');
  process.exit(1);
}

try {
  const result = importCollectorPrematchSnapshots(filePath, 'sofascore', gameId);
  console.log(JSON.stringify(result, null, 2));
  if (result.rejected.length) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
