/**
 * 投手傷病／恢復期情報：
 * Google News RSS 檢索 → DeepSeek 結構化旗標 → SQLite 快取。
 * 研究證據用，不自動改預期得分權重、不產生投注建議。
 */
import db from '../db/database.js';
import { config } from '../config.js';
import { searchPitcherNewsMaterials } from './PitcherNewsSearchService.js';

const SYSTEM_PROMPT = `你是棒球賽前情報抽取器，不是投注顧問。
只根據使用者提供的 materials 與 commenceTime 做判斷；材料不足就降低 confidence，禁止編造手術日期、傷病或來源。
重點區分「今晚仍有風險」與「舊傷／已康復敘事」：
- pregame_active：開賽前仍可能影響登板（IL 中、當日 scratch、疼痛未愈、術後未穩定復出）
- recent_return：近約 14–21 天內剛從傷兵／手術歸隊，仍可能不穩
- historical_only：只是舊傷、舊新聞、或已明確康復且正常輪值
- none：無相關健康風險
sources 只能引用 materials 裡出現過的 url；沒有 url 就留空陣列。
只輸出一個 JSON 物件，不要 markdown，不要解釋。`;

const RISK_TIMINGS = new Set([
  'pregame_active',
  'recent_return',
  'historical_only',
  'none',
]);

function buildUserPrompt({
  pitcherName,
  teamName = null,
  league = null,
  commenceTime = null,
  materials = [],
}) {
  return JSON.stringify({
    task: 'extract_pitcher_injury_recovery_flags_v2',
    pitcherName,
    teamName,
    league,
    commenceTime,
    materials,
    output_schema: {
      injury_flag: 'boolean — 材料是否提到傷病／IL／疼痛／手術相關健康問題',
      surgery_recovery: 'boolean — 是否仍處於手術後恢復期或術後負荷管理',
      workload_management: 'boolean — 是否提到負荷管理、opener、拉長間隔、暫時註銷等',
      risk_timing: 'enum: pregame_active | recent_return | historical_only | none',
      confidence: 'number 0到1 — 對 risk_timing 判斷的信心',
      summary: 'string 一句話中文摘要，僅基於材料，並點明是否已康復',
      sources: 'array of {url, title}',
      evidence_quotes: 'array of string 關鍵原句，可短',
    },
    decision_rules: [
      '若材料顯示已回歸且近期正常先發、無新傷，即使提過舊傷也應 historical_only 或 none',
      '若材料顯示當日撤先發、仍在 IL、術後剛復出不穩，才用 pregame_active / recent_return',
      '不要因為標題出現 injury 就自動當成今晚高風險',
    ],
  }, null, 2);
}

function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeRiskTiming(value) {
  const timing = String(value || 'none').trim().toLowerCase();
  return RISK_TIMINGS.has(timing) ? timing : 'none';
}

export function isActivePitcherRisk(flags) {
  if (!flags) return false;
  const timing = normalizeRiskTiming(flags.risk_timing);
  // 僅當日風險／近期歸隊才進模型候選；歷史手術敘事不得單獨觸發
  return timing === 'pregame_active' || timing === 'recent_return';
}

function normalizeFlagResult(raw, materials) {
  const allowedUrls = new Set(
    (materials || [])
      .map((item) => item?.url)
      .filter((url) => typeof url === 'string' && url.length > 0)
  );
  const sources = Array.isArray(raw?.sources)
    ? raw.sources
      .filter((item) => item && allowedUrls.has(item.url))
      .map((item) => ({
        url: String(item.url),
        title: item.title == null ? null : String(item.title),
      }))
    : [];
  const confidence = Number(raw?.confidence);
  const risk_timing = normalizeRiskTiming(raw?.risk_timing);
  const result = {
    injury_flag: Boolean(raw?.injury_flag),
    surgery_recovery: Boolean(raw?.surgery_recovery),
    workload_management: Boolean(raw?.workload_management),
    risk_timing,
    confidence: Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0,
    summary: raw?.summary == null ? '' : String(raw.summary).slice(0, 280),
    sources,
    evidence_quotes: Array.isArray(raw?.evidence_quotes)
      ? raw.evidence_quotes.map((quote) => String(quote).slice(0, 200)).slice(0, 6)
      : [],
  };
  result.active_risk = isActivePitcherRisk(result);
  return result;
}

export function isDeepseekConfigured() {
  return Boolean(config.deepseekApiKey);
}

export async function extractPitcherInjuryFlags(input) {
  if (!config.deepseekApiKey) {
    return {
      ok: false,
      error: 'deepseek_api_key_missing',
      result: null,
    };
  }
  const materials = Array.isArray(input?.materials) ? input.materials : [];
  if (!input?.pitcherName) {
    return { ok: false, error: 'pitcher_name_missing', result: null };
  }
  if (!materials.length) {
    return {
      ok: true,
      result: normalizeFlagResult({
        injury_flag: false,
        surgery_recovery: false,
        workload_management: false,
        risk_timing: 'none',
        confidence: 0,
        summary: '無可用賽前材料',
        sources: [],
        evidence_quotes: [],
      }, materials),
      usage: null,
      model: config.deepseekModel,
    };
  }

  const baseUrl = String(config.deepseekBaseUrl || 'https://api.deepseek.com')
    .replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel || 'deepseek-chat',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildUserPrompt({
            pitcherName: input.pitcherName,
            teamName: input.teamName,
            league: input.league,
            commenceTime: input.commenceTime,
            materials,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      ok: false,
      error: `deepseek_http_${response.status}`,
      detail: detail.slice(0, 500),
      result: null,
    };
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(content);
  if (!parsed) {
    return {
      ok: false,
      error: 'deepseek_invalid_json',
      detail: String(content || '').slice(0, 500),
      result: null,
    };
  }

  return {
    ok: true,
    result: normalizeFlagResult(parsed, materials),
    usage: payload?.usage || null,
    model: payload?.model || config.deepseekModel,
  };
}

function cacheKeyFor({ gameId = null, pitcherId = null, pitcherName, commenceTime = null }) {
  const day = commenceTime ? String(commenceTime).slice(0, 10) : 'unknown-day';
  if (gameId && pitcherId) return `${gameId}:${pitcherId}`;
  if (gameId && pitcherName) return `${gameId}:${pitcherName}`;
  if (pitcherId) return `pitcher:${pitcherId}:${day}`;
  return `name:${pitcherName}:${day}`;
}

function readIntelCache(cacheKey, maxAgeHours) {
  const row = db.prepare(`
    SELECT *
    FROM mlb_pitcher_injury_intel_cache
    WHERE cache_key = ?
  `).get(cacheKey);
  if (!row) return null;
  const ageMs = Date.now() - Date.parse(String(row.fetched_at).includes('T')
    ? row.fetched_at
    : `${row.fetched_at.replace(' ', 'T')}Z`);
  const ageHours = Number.isFinite(ageMs) ? ageMs / 3600000 : 0;
  if (ageHours > maxAgeHours) return null;
  try {
    return {
      cacheHit: true,
      cacheKey,
      status: row.status,
      error: row.error,
      materials: JSON.parse(row.materials_json || '[]'),
      result: JSON.parse(row.flags_json || 'null'),
      model: row.model,
      fetchedAt: row.fetched_at,
      pitcherName: row.pitcher_name,
      pitcherId: row.pitcher_id,
      gameId: row.game_id,
      league: row.league,
      commenceTime: row.commence_time,
    };
  } catch {
    return null;
  }
}

function writeIntelCache(entry) {
  db.prepare(`
    INSERT INTO mlb_pitcher_injury_intel_cache (
      cache_key, game_id, pitcher_id, pitcher_name, league, commence_time,
      materials_json, flags_json, model, status, error, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cache_key) DO UPDATE SET
      game_id = excluded.game_id,
      pitcher_id = excluded.pitcher_id,
      pitcher_name = excluded.pitcher_name,
      league = excluded.league,
      commence_time = excluded.commence_time,
      materials_json = excluded.materials_json,
      flags_json = excluded.flags_json,
      model = excluded.model,
      status = excluded.status,
      error = excluded.error,
      fetched_at = datetime('now')
  `).run(
    entry.cacheKey,
    entry.gameId || null,
    entry.pitcherId || null,
    entry.pitcherName,
    entry.league || null,
    entry.commenceTime || null,
    JSON.stringify(entry.materials || []),
    JSON.stringify(entry.result || null),
    entry.model || null,
    entry.status,
    entry.error || null
  );
}

function mergeOfficialMaterials(materials, officialNotes = []) {
  const merged = [...(materials || [])];
  for (const note of officialNotes || []) {
    if (!note?.snippet && !note?.title) continue;
    merged.unshift({
      title: note.title || 'Official roster / IL note',
      url: note.url || `mlb-official://note/${merged.length + 1}`,
      publishedAt: note.publishedAt || null,
      snippet: note.snippet || '',
      source: note.source || 'official',
    });
  }
  return merged;
}

export async function analyzePitcherInjuryIntel({
  pitcherName,
  pitcherId = null,
  teamName = null,
  league = 'MLB',
  gameId = null,
  commenceTime = null,
  officialNotes = [],
  force = false,
} = {}) {
  if (!config.enablePitcherInjuryIntel) {
    return {
      ok: false,
      disabled: true,
      error: 'pitcher_injury_intel_disabled',
      result: null,
      materials: [],
    };
  }
  if (!pitcherName) {
    return { ok: false, error: 'pitcher_name_missing', result: null, materials: [] };
  }

  const cacheKey = cacheKeyFor({ gameId, pitcherId, pitcherName, commenceTime });
  if (!force) {
    const cached = readIntelCache(cacheKey, config.pitcherInjuryIntelCacheHours);
    if (cached) {
      return {
        ok: cached.status === 'ok' || cached.status === 'partial',
        ...cached,
      };
    }
  }

  const search = await searchPitcherNewsMaterials({
    pitcherName,
    teamName,
    league,
    limit: config.pitcherInjuryIntelMaxMaterials,
  });
  const materials = mergeOfficialMaterials(search.materials, officialNotes);

  if (!isDeepseekConfigured()) {
    const payload = {
      cacheKey,
      gameId,
      pitcherId,
      pitcherName,
      league,
      commenceTime,
      materials,
      result: null,
      model: null,
      status: 'missing_api_key',
      error: 'deepseek_api_key_missing',
    };
    writeIntelCache(payload);
    return { ok: false, ...payload, search };
  }

  const extracted = await extractPitcherInjuryFlags({
    pitcherName,
    teamName,
    league,
    commenceTime,
    materials,
  });

  if (!extracted.ok) {
    const payload = {
      cacheKey,
      gameId,
      pitcherId,
      pitcherName,
      league,
      commenceTime,
      materials,
      result: null,
      model: extracted.model || config.deepseekModel,
      status: 'error',
      error: extracted.error,
      detail: extracted.detail || null,
    };
    writeIntelCache(payload);
    return { ok: false, ...payload, search, usage: extracted.usage || null };
  }

  const status = materials.length ? 'ok' : 'partial';
  const payload = {
    cacheKey,
    gameId,
    pitcherId,
    pitcherName,
    league,
    commenceTime,
    materials,
    result: extracted.result,
    model: extracted.model,
    status,
    error: search.ok ? null : search.error,
  };
  writeIntelCache(payload);
  return {
    ok: true,
    cacheHit: false,
    ...payload,
    search,
    usage: extracted.usage || null,
  };
}

export async function analyzeGamePitcherInjuryIntel({
  gameId,
  commenceTime,
  homeTeam,
  awayTeam,
  homePitcher,
  awayPitcher,
  league = 'MLB',
  homeOfficialNotes = [],
  awayOfficialNotes = [],
  force = false,
} = {}) {
  const [home, away] = await Promise.all([
    homePitcher?.name
      ? analyzePitcherInjuryIntel({
          pitcherName: homePitcher.name,
          pitcherId: homePitcher.id || null,
          teamName: homeTeam,
          league,
          gameId,
          commenceTime,
          officialNotes: homeOfficialNotes,
          force,
        })
      : Promise.resolve({
          ok: false,
          error: 'home_pitcher_missing',
          result: null,
          materials: [],
        }),
    awayPitcher?.name
      ? analyzePitcherInjuryIntel({
          pitcherName: awayPitcher.name,
          pitcherId: awayPitcher.id || null,
          teamName: awayTeam,
          league,
          gameId,
          commenceTime,
          officialNotes: awayOfficialNotes,
          force,
        })
      : Promise.resolve({
          ok: false,
          error: 'away_pitcher_missing',
          result: null,
          materials: [],
        }),
  ]);
  return { home, away };
}

export function summarizePitcherInjuryIntelEvidence(homeIntel, awayIntel) {
  const sides = [
    { side: 'home', intel: homeIntel },
    { side: 'away', intel: awayIntel },
  ];
  const risky = sides.filter(({ intel }) => isActivePitcherRisk(intel?.result));
  const okCount = sides.filter(({ intel }) => intel?.ok).length;
  let status = 'missing';
  if (okCount === 2) status = risky.length ? 'partial' : 'verified';
  else if (okCount === 1) status = 'partial';

  const formatSide = (label, intel) => {
    if (!intel?.ok || !intel.result) return `${label}=無`;
    const timing = intel.result.risk_timing || 'none';
    const active = isActivePitcherRisk(intel.result);
    return `${label} ${intel.pitcherName || ''}：${active ? '有效風險' : '無有效風險'}` +
      `（${timing}／信心 ${Number(intel.result.confidence || 0).toFixed(2)}）`;
  };

  return {
    status,
    summary: `${formatSide('主', homeIntel)}；${formatSide('客', awayIntel)}。研究用旗標，未進模型權重。`,
    values: {
      usedInModel: false,
      home: {
        ok: homeIntel?.ok || false,
        pitcherName: homeIntel?.pitcherName || null,
        result: homeIntel?.result || null,
        materialsCount: homeIntel?.materials?.length || 0,
        model: homeIntel?.model || null,
        error: homeIntel?.error || null,
      },
      away: {
        ok: awayIntel?.ok || false,
        pitcherName: awayIntel?.pitcherName || null,
        result: awayIntel?.result || null,
        materialsCount: awayIntel?.materials?.length || 0,
        model: awayIntel?.model || null,
        error: awayIntel?.error || null,
      },
      riskySides: risky.map((entry) => entry.side),
    },
    reason: risky.length
      ? 'pitcher_recovery_or_injury_flagged'
      : okCount
        ? 'pitcher_injury_intel_scanned'
        : 'pitcher_injury_intel_unavailable',
  };
}

export function listRecentPitcherInjuryIntel({ limit = 20 } = {}) {
  return db.prepare(`
    SELECT cache_key, game_id, pitcher_id, pitcher_name, league, commence_time,
           status, model, error, fetched_at, flags_json, materials_json
    FROM mlb_pitcher_injury_intel_cache
    ORDER BY datetime(fetched_at) DESC
    LIMIT ?
  `).all(limit).map((row) => {
    let result = null;
    let materialsCount = 0;
    try { result = JSON.parse(row.flags_json); } catch { /* ignore */ }
    try { materialsCount = JSON.parse(row.materials_json || '[]').length; } catch { /* ignore */ }
    return {
      cacheKey: row.cache_key,
      gameId: row.game_id,
      pitcherId: row.pitcher_id,
      pitcherName: row.pitcher_name,
      league: row.league,
      commenceTime: row.commence_time,
      status: row.status,
      model: row.model,
      error: row.error,
      fetchedAt: row.fetched_at,
      result,
      materialsCount,
    };
  });
}
