import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import apiRouter from './routes/api.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/api', apiRouter);

app.listen(config.port, () => {
  console.log(`Baseball Analytics API: http://localhost:${config.port}`);
  if (!config.oddsApiKey) {
    console.warn('警告: 未設定 ODDS_API_KEY，請複製 .env.example 為 .env 並填入 key');
  } else {
    console.log('ODDS_API_KEY 已載入');
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被佔用，請修改 backend/.env 的 PORT 或關閉佔用進程`);
    process.exit(1);
  }
  throw err;
});
