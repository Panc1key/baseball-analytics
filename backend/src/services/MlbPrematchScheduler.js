import cron from 'node-cron';
import db from '../db/database.js';
import { config } from '../config.js';
import { fullRefresh } from './AnalysisEngine.js';

const MLB_CODE = 'MLB';
let scheduledTasks = [];
let schedulerStarted = false;

function isoNow(now = new Date()) {
  return now.toISOString();
}

function timezoneDateTimeKey(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

export function parseFixedSnapshotHours(value = config.prematchFixedSnapshotHours) {
  return [...new Set(
    String(value)
      .split(',')
      .map((hour) => parseInt(hour.trim(), 10))
      .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
  )].sort((a, b) => a - b);
}

export function getDuePregameWindows(
  games,
  {
    now = new Date(),
    windowsMinutes = config.prematchSnapshotWindowsMinutes,
    graceMinutes = config.prematchSchedulerGraceMinutes,
  } = {}
) {
  const nowMs = now.getTime();
  const normalizedGraceMinutes = Number.isFinite(Number(graceMinutes))
    ? Math.max(1, Number(graceMinutes))
    : 12;
  const graceMs = normalizedGraceMinutes * 60_000;

  return (games || []).flatMap((game) => {
    const commenceMs = Date.parse(game.commence_time);
    if (!Number.isFinite(commenceMs)) return [];

    return (windowsMinutes || []).flatMap((minutesBefore) => {
      const scheduledMs = commenceMs - minutesBefore * 60_000;
      const elapsedMs = nowMs - scheduledMs;
      if (elapsedMs < 0 || elapsedMs > graceMs || nowMs >= commenceMs) return [];
      return [{
        game,
        minutesBefore,
        scheduledFor: new Date(scheduledMs).toISOString(),
        runKey: `window:${game.id}:T-${minutesBefore}`,
      }];
    });
  });
}

function claimRun({ runKey, triggerType, gameId = null, scheduledFor }) {
  try {
    db.prepare(`
      INSERT INTO mlb_prematch_scheduler_runs
        (run_key, trigger_type, game_id, scheduled_for, status)
      VALUES (?, ?, ?, ?, 'running')
    `).run(runKey, triggerType, gameId, scheduledFor);
    return true;
  } catch {
    const previous = db.prepare(`
      SELECT status, started_at
      FROM mlb_prematch_scheduler_runs
      WHERE run_key = ?
    `).get(runKey);
    const startedMs = Date.parse(previous?.started_at || '');
    const staleRunning = previous?.status === 'running' &&
      Number.isFinite(startedMs) &&
      Date.now() - startedMs > 30 * 60_000;
    if (previous?.status !== 'failed' && !staleRunning) return false;

    db.prepare(`
      UPDATE mlb_prematch_scheduler_runs
      SET trigger_type = ?, game_id = ?, scheduled_for = ?, started_at = datetime('now'),
          finished_at = NULL, status = 'running', error_message = NULL, result_json = NULL
      WHERE run_key = ?
    `).run(triggerType, gameId, scheduledFor, runKey);
    return true;
  }
}

function finishRuns(claims, { result = null, error = null } = {}) {
  const status = error ? 'failed' : 'completed';
  const statement = db.prepare(`
    UPDATE mlb_prematch_scheduler_runs
    SET finished_at = datetime('now'), status = ?, error_message = ?, result_json = ?
    WHERE run_key = ?
  `);
  const resultJson = result ? JSON.stringify(result) : null;
  const errorMessage = error ? String(error.message || error).slice(0, 1000) : null;
  const transaction = db.transaction(() => {
    for (const claim of claims) {
      statement.run(status, errorMessage, resultJson, claim.runKey);
    }
  });
  transaction();
}

function recoverInterruptedRuns() {
  const recovered = db.prepare(`
    UPDATE mlb_prematch_scheduler_runs
    SET status = 'failed',
        finished_at = datetime('now'),
        error_message = COALESCE(error_message, 'server_restarted_or_refresh_timeout')
    WHERE status = 'running'
      AND datetime(started_at) < datetime('now', '-30 minutes')
  `).run().changes;
  if (recovered) {
    console.warn(`[prematch-scheduler] 已標記 ${recovered} 筆中斷排程為 failed`);
  }
}

async function executeClaims(claims) {
  if (!claims.length) return { skipped: true, reason: 'already_recorded' };

  try {
    const result = await fullRefresh({ leagueCodes: [MLB_CODE] });
    finishRuns(claims, { result: {
      games: result?.mlbTruth?.games ?? 0,
      collected: result?.mlbTruth?.collected ?? 0,
      oddsQuotaRemaining: result?.sync?.oddsQuota?.remaining ?? null,
    } });
    return { skipped: false, claims: claims.length, result };
  } catch (error) {
    finishRuns(claims, { error });
    throw error;
  }
}

export async function runFixedPrematchSnapshot(now = new Date()) {
  const localKey = timezoneDateTimeKey(now, config.prematchSnapshotTimezone);
  const claim = {
    runKey: `fixed:${localKey}`,
    triggerType: 'fixed',
    scheduledFor: isoNow(now),
  };
  if (!claimRun(claim)) return { skipped: true, reason: 'already_recorded' };
  return executeClaims([claim]);
}

export async function runDuePregameSnapshots(now = new Date()) {
  const maxMinutes = Math.max(...config.prematchSnapshotWindowsMinutes, 0);
  const games = db.prepare(`
    SELECT id, commence_time
    FROM games
    WHERE league = ?
      AND completed = 0
      AND datetime(commence_time) > datetime('now', '-1 hour')
      AND datetime(commence_time) <= datetime('now', ?)
  `).all(MLB_CODE, `+${maxMinutes + 1} minutes`);

  const due = getDuePregameWindows(games, { now });
  const claims = due.filter((entry) => claimRun({
    runKey: entry.runKey,
    triggerType: 'pregame_window',
    gameId: entry.game.id,
    scheduledFor: entry.scheduledFor,
  }));
  return executeClaims(claims);
}

export function getMlbPrematchSchedulerStatus() {
  const recentRuns = db.prepare(`
    SELECT run_key, trigger_type, game_id, scheduled_for, started_at, finished_at, status, error_message
    FROM mlb_prematch_scheduler_runs
    ORDER BY datetime(started_at) DESC
    LIMIT 20
  `).all();

  return {
    enabled: config.prematchSchedulerEnabled,
    started: schedulerStarted,
    timezone: config.prematchSnapshotTimezone,
    fixedHours: parseFixedSnapshotHours(),
    pregameWindowsMinutes: config.prematchSnapshotWindowsMinutes,
    windowCheckCron: config.prematchWindowCheckCron,
    recentRuns,
  };
}

export function startMlbPrematchScheduler() {
  if (schedulerStarted || !config.prematchSchedulerEnabled) return getMlbPrematchSchedulerStatus();
  recoverInterruptedRuns();

  const fixedHours = parseFixedSnapshotHours();
  const fixedCron = `0 ${fixedHours.join(',')} * * *`;
  if (fixedHours.length && cron.validate(fixedCron)) {
    scheduledTasks.push(cron.schedule(fixedCron, () => {
      runFixedPrematchSnapshot().catch((error) => {
        console.error('[prematch-scheduler] 固定快照失敗:', error.message);
      });
    }, { timezone: config.prematchSnapshotTimezone }));
  }

  if (cron.validate(config.prematchWindowCheckCron)) {
    scheduledTasks.push(cron.schedule(config.prematchWindowCheckCron, () => {
      runDuePregameSnapshots().catch((error) => {
        console.error('[prematch-scheduler] 賽前窗口快照失敗:', error.message);
      });
    }, { timezone: config.prematchSnapshotTimezone }));
  } else {
    console.error(`[prematch-scheduler] 無效 cron：${config.prematchWindowCheckCron}`);
  }

  schedulerStarted = true;
  console.log(
    `[prematch-scheduler] 已啟動：固定 ${fixedHours.join(',') || '無'} 時` +
      `；窗口 ${config.prematchWindowCheckCron}；${config.prematchSnapshotTimezone}`
  );
  return getMlbPrematchSchedulerStatus();
}

export function stopMlbPrematchScheduler() {
  for (const task of scheduledTasks) task.stop();
  scheduledTasks = [];
  schedulerStarted = false;
}
