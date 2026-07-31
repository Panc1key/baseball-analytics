/**
 * MLB IL 交易事件：可回放的「傷愈啟用」基礎設施。
 * 來源 statsapi.mlb.com/api/v1/transactions（免費）。
 * 正式選注常數不改；本層只供影子／v4.6 特徵。
 */
import db from '../db/database.js';

const TX_URL = 'https://statsapi.mlb.com/api/v1/transactions';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseIlTransaction(tx) {
  const desc = String(tx?.description || '');
  const personId = Number(tx?.person?.id);
  if (!Number.isFinite(personId)) return null;

  let eventKind = null;
  if (/placed .+ on the \d+-day injured list/i.test(desc) || /placed .+ on the injured list/i.test(desc)) {
    eventKind = 'placed';
  } else if (/activated .+ from the \d+-day injured list/i.test(desc) || /activated .+ from the injured list/i.test(desc)) {
    eventKind = 'activated';
  } else {
    return null;
  }

  const daysMatch = desc.match(/(\d+)-day injured list/i);
  const ilDays = daysMatch ? Number(daysMatch[1]) : null;
  const eventDate = tx.date || tx.effectiveDate || tx.resolutionDate;
  if (!eventDate) return null;

  return {
    transactionId: Number(tx.id),
    pitcherId: personId,
    pitcherName: tx.person?.fullName || null,
    teamId: Number(tx.toTeam?.id) || Number(tx.fromTeam?.id) || null,
    eventDate: String(eventDate).slice(0, 10),
    effectiveDate: tx.effectiveDate ? String(tx.effectiveDate).slice(0, 10) : null,
    eventKind,
    ilDays: Number.isFinite(ilDays) ? ilDays : null,
    typeCode: tx.typeCode || null,
    typeDesc: tx.typeDesc || null,
    description: desc,
    payload: tx,
  };
}

export async function fetchMlbTransactionsRange(startDate, endDate, { sportId = 1 } = {}) {
  const url = new URL(TX_URL);
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  url.searchParams.set('sportId', String(sportId));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`transactions HTTP ${res.status} ${startDate}..${endDate}`);
  }
  const json = await res.json();
  return Array.isArray(json.transactions) ? json.transactions : [];
}

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO mlb_il_transaction_events
    (transaction_id, pitcher_id, pitcher_name, team_id, event_date, effective_date,
     event_kind, il_days, type_code, type_desc, description, payload_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function persistIlEvents(events) {
  let inserted = 0;
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      const r = insertEvent.run(
        e.transactionId,
        e.pitcherId,
        e.pitcherName,
        e.teamId,
        e.eventDate,
        e.effectiveDate,
        e.eventKind,
        e.ilDays,
        e.typeCode,
        e.typeDesc,
        e.description,
        JSON.stringify(e.payload || {})
      );
      if (r.changes) inserted += 1;
    }
  });
  tx(events);
  return { inserted, scanned: events.length };
}

export async function syncMlbIlTransactionsRange(startDate, endDate, { pauseMs = 120 } = {}) {
  const raw = await fetchMlbTransactionsRange(startDate, endDate);
  const events = [];
  for (const tx of raw) {
    const parsed = parseIlTransaction(tx);
    if (parsed) events.push(parsed);
  }
  const result = persistIlEvents(events);
  if (pauseMs > 0) await sleep(pauseMs);
  return {
    startDate,
    endDate,
    rawTransactions: raw.length,
    ilEvents: events.length,
    ...result,
  };
}

/** 切月回填 */
export async function syncMlbIlTransactionsByMonth(fromYm, toYm, opts = {}) {
  const [fy, fm] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  let y = fy;
  let m = fm;
  const logs = [];
  while (y < ty || (y === ty && m <= tm)) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const log = await syncMlbIlTransactionsRange(start, end, opts);
    logs.push(log);
    console.log('[il-sync]', log.startDate, '..', log.endDate, 'il', log.ilEvents, 'ins', log.inserted);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return logs;
}

/**
 * 在 asOfDate（不含當日開賽後）之前，最近一次 IL activated。
 * asOfDate: YYYY-MM-DD（通常用開賽港日或 UTC 日期的前一日語意：event_date < commenceDate）
 */
export function getLastIlActivation(pitcherId, beforeDateInclusiveExclusive) {
  const id = Number(pitcherId);
  if (!Number.isFinite(id)) return null;
  const before = String(beforeDateInclusiveExclusive).slice(0, 10);
  return (
    db
      .prepare(
        `SELECT *
         FROM mlb_il_transaction_events
         WHERE pitcher_id = ?
           AND event_kind = 'activated'
           AND date(event_date) < date(?)
         ORDER BY date(event_date) DESC, id DESC
         LIMIT 1`
      )
      .get(id, before) || null
  );
}

export function daysBetween(isoA, isoB) {
  const a = Date.parse(`${String(isoA).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(isoB).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86400000);
}

/**
 * Grok C 契約（可回放）：
 * days_since_last_il_exit <= 45
 * season_ip_before（由呼叫端傳入）< 30
 * career_ip 可選（暫不強制）
 */
export function buildIlReturnFlag({
  pitcherId,
  commenceDate,
  seasonIpBefore = null,
  maxDaysSinceExit = 45,
  maxSeasonIp = 30,
  requireCareerIp = false,
  careerIp = null,
} = {}) {
  const act = getLastIlActivation(pitcherId, commenceDate);
  if (!act) {
    return {
      isReturnPitcher: false,
      reason: 'no_prior_il_activation',
      daysSinceLastIlExit: null,
      activatedAt: null,
      seasonIpBefore: seasonIpBefore ?? null,
    };
  }
  const days = daysBetween(act.event_date, commenceDate);
  const ipOk =
    seasonIpBefore == null ||
    (Number.isFinite(Number(seasonIpBefore)) && Number(seasonIpBefore) < maxSeasonIp);
  const careerOk =
    !requireCareerIp ||
    (Number.isFinite(Number(careerIp)) && Number(careerIp) > 100);
  const within = Number.isFinite(days) && days >= 0 && days <= maxDaysSinceExit;
  return {
    isReturnPitcher: Boolean(within && ipOk && careerOk),
    reason: within
      ? ipOk
        ? careerOk
          ? 'matched'
          : 'career_ip_gate'
        : 'season_ip_gate'
      : 'outside_window',
    daysSinceLastIlExit: days,
    activatedAt: act.event_date,
    ilDays: act.il_days,
    seasonIpBefore: seasonIpBefore ?? null,
    description: act.description,
  };
}

export function getMlbIlEventCoverage() {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS events,
         SUM(CASE WHEN event_kind='placed' THEN 1 ELSE 0 END) AS placed,
         SUM(CASE WHEN event_kind='activated' THEN 1 ELSE 0 END) AS activated,
         MIN(event_date) AS fromDate,
         MAX(event_date) AS toDate,
         COUNT(DISTINCT pitcher_id) AS pitchers
       FROM mlb_il_transaction_events`
    )
    .get();
  return {
    events: Number(row?.events || 0),
    placed: Number(row?.placed || 0),
    activated: Number(row?.activated || 0),
    fromDate: row?.fromDate || null,
    toDate: row?.toDate || null,
    pitchers: Number(row?.pitchers || 0),
  };
}
