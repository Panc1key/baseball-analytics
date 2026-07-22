import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import apiRouter from './routes/api.js';
import footballRouter from './routes/football.js';
import basketballRouter from './routes/basketball.js';
import tennisRouter from './routes/tennis.js';
import { startMlbPrematchScheduler } from './services/MlbPrematchScheduler.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api', apiRouter);
app.use('/api/football', footballRouter);
app.use('/api/basketball', basketballRouter);
app.use('/api/tennis', tennisRouter);

app.listen(config.port, () => {
  console.log(`Baseball Analytics API: http://localhost:${config.port}`);
  console.log(`Football: /api/football · Basketball: /api/basketball · Tennis: /api/tennis`);
  if (!config.oddsApiKey) {
    console.warn('警告: 未設定 ODDS_API_KEY，請複製 .env.example 為 .env 並填入 key');
  } else {
    console.log('ODDS_API_KEY 已載入');
  }
  if (!process.env.API_FOOTBALL_KEY) {
    console.warn('提示: 未設定 API_FOOTBALL_KEY，足球分析將僅用賠率與比分（建議接入以啟用陣容/戰術）');
  } else {
    console.log('API_FOOTBALL_KEY 已載入（陣容/傷病/戰術）');
  }
  startMlbPrematchScheduler();
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被佔用，請修改 backend/.env 的 PORT 或關閉佔用進程`);
    process.exit(1);
  }
  throw err;
});
