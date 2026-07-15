import { runAnalysis } from '../services/AnalysisEngine.js';

try {
  const result = await runAnalysis();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('[analyze] 初盤分析失敗:', error);
  process.exitCode = 1;
}
