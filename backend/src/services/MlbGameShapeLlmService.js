/**
 * DeepSeek 赛前形态标注服务：批量打标 + SQLite 缓存。
 * 只吃数字事实，不搜新闻。用于大规模标注 → 蒸馏规则。
 */
import db from '../db/database.js';
import { config } from '../config.js';

export const GAME_SHAPE_PROMPT_VERSION = 'game_shape_batch_v1';

const SYSTEM_PROMPT = `你是棒球赛前形态判读助手，不是投注顾问。
只根据提供的数字判断每场：
- pitcher_duel：双方先发都不差，且总分开得偏低，像投手战（应偏小球，别追大分）
- strong_home：主队明显更强/市场主胜赔率偏低（应偏主胜）
材料不足就 false + 低 confidence。禁止编造未给出的信息。
只输出 JSON：{"games":[{"id":"...","pitcher_duel":bool,"strong_home":bool,"confidence":0到1,"reason":"一句话中文"}]}`;

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_game_shape_llm_cache (
      game_id TEXT PRIMARY KEY,
      commence_time TEXT,
      facts_json TEXT NOT NULL,
      label_json TEXT NOT NULL,
      model TEXT,
      prompt_version TEXT NOT NULL,
      usage_json TEXT,
      status TEXT NOT NULL,
      error TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

ensureTable();

export function isDeepseekConfigured() {
  return Boolean(config.deepseekApiKey);
}

export function getCachedGameShapeLabel(gameId, promptVersion = GAME_SHAPE_PROMPT_VERSION) {
  const row = db
    .prepare(
      `SELECT * FROM mlb_game_shape_llm_cache
       WHERE game_id = ? AND prompt_version = ? AND status = 'ok'`
    )
    .get(gameId, promptVersion);
  if (!row) return null;
  try {
    return {
      ...JSON.parse(row.label_json),
      model: row.model,
      cached: true,
    };
  } catch {
    return null;
  }
}

export function upsertGameShapeLabel({
  gameId,
  commenceTime = null,
  facts,
  label,
  model = null,
  usage = null,
  status = 'ok',
  error = null,
  promptVersion = GAME_SHAPE_PROMPT_VERSION,
}) {
  db.prepare(
    `INSERT INTO mlb_game_shape_llm_cache (
       game_id, commence_time, facts_json, label_json, model,
       prompt_version, usage_json, status, error, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(game_id) DO UPDATE SET
       commence_time = excluded.commence_time,
       facts_json = excluded.facts_json,
       label_json = excluded.label_json,
       model = excluded.model,
       prompt_version = excluded.prompt_version,
       usage_json = excluded.usage_json,
       status = excluded.status,
       error = excluded.error,
       fetched_at = datetime('now')`
  ).run(
    gameId,
    commenceTime,
    JSON.stringify(facts || {}),
    JSON.stringify(label || {}),
    model,
    promptVersion,
    usage ? JSON.stringify(usage) : null,
    status,
    error
  );
}

export async function classifyGameShapeBatch(factsList, {
  model = null,
  timeoutMs = 60000,
} = {}) {
  if (!config.deepseekApiKey) {
    return { ok: false, error: 'deepseek_api_key_missing', games: [] };
  }
  const useModel = model || config.deepseekModel || 'deepseek-v4-flash';
  const baseUrl = String(config.deepseekBaseUrl || 'https://api.deepseek.com').replace(
    /\/$/,
    ''
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deepseekApiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: useModel,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              task: GAME_SHAPE_PROMPT_VERSION,
              games: factsList,
            }),
          },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: err?.name === 'AbortError' ? 'deepseek_timeout' : `deepseek_fetch_${err?.message || err}`,
      games: [],
    };
  }
  clearTimeout(timer);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      ok: false,
      error: `deepseek_http_${response.status}`,
      detail: detail.slice(0, 400),
      games: [],
    };
  }
  const payload = await response.json();
  let parsed = {};
  try {
    parsed = JSON.parse(payload?.choices?.[0]?.message?.content || '{}');
  } catch {
    parsed = {};
  }
  return {
    ok: true,
    games: Array.isArray(parsed.games) ? parsed.games : [],
    usage: payload.usage || null,
    model: payload.model || useModel,
  };
}

/**
 * 单场赛前：有缓存用缓存，否则现场打一次 DeepSeek（用于真实推荐）。
 */
export async function ensureLiveGameShapeLabel({
  gameId,
  commenceTime = null,
  facts,
  force = false,
  model = null,
} = {}) {
  if (!gameId || !facts) {
    return { ok: false, error: 'missing_game_or_facts', label: null };
  }
  if (!force) {
    const cached = getCachedGameShapeLabel(gameId);
    if (cached) return { ok: true, label: cached, source: 'cache' };
  }
  if (!isDeepseekConfigured()) {
    return { ok: false, error: 'deepseek_api_key_missing', label: null };
  }
  const out = await classifyGameShapeBatch([facts], { model, timeoutMs: 45000 });
  if (!out.ok) {
    upsertGameShapeLabel({
      gameId,
      commenceTime,
      facts,
      label: {},
      model: model || config.deepseekModel,
      status: 'error',
      error: out.error,
    });
    return { ok: false, error: out.error, label: null };
  }
  const label = out.games.find((g) => String(g.id) === String(gameId)) || out.games[0] || {
    pitcher_duel: false,
    strong_home: false,
    confidence: 0,
    reason: 'empty_response',
  };
  upsertGameShapeLabel({
    gameId,
    commenceTime,
    facts: { ...facts, live: true },
    label,
    model: out.model,
    usage: out.usage,
    status: 'ok',
  });
  return {
    ok: true,
    label: { ...label, model: out.model, cached: false },
    source: 'live',
    usage: out.usage,
  };
}

export function countGameShapeCache({ promptVersion = GAME_SHAPE_PROMPT_VERSION } = {}) {
  return db
    .prepare(
      `SELECT status, COUNT(*) AS n
       FROM mlb_game_shape_llm_cache
       WHERE prompt_version = ?
       GROUP BY status`
    )
    .all(promptVersion);
}
