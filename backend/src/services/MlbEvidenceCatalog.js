/**
 * MLB 賽前證據權重目錄（顯示＋推薦閘門）
 *
 * critical：未 verified 不得進鎖定 B 推薦／紙上晉升
 * high／medium／low：顯示完整度權重，不單獨硬擋（除非列入 critical）
 */
export const MLB_EVIDENCE_CATALOG = Object.freeze([
  Object.freeze({
    key: 'odds',
    label: '初盤雙邊賠率',
    weight: 100,
    tier: 'critical',
    blockRecommend: true,
    why: '沒有可驗證開賽前盤口無法定價／算 EV',
  }),
  Object.freeze({
    key: 'starting_pitchers',
    label: '雙方預定先發',
    weight: 95,
    tier: 'critical',
    blockRecommend: true,
    // 鎖定 B 用的是官方 probable（PIT），不是確認打線；partial=雙方預定已齊
    acceptStatuses: Object.freeze(['verified', 'partial']),
    why: '鎖定 B 模型高度依賴先發；缺一邊會走 fallback，易錯推',
  }),
  Object.freeze({
    key: 'fixture',
    label: '官方賽程匹配',
    weight: 90,
    tier: 'critical',
    blockRecommend: true,
    why: '對不上官方場次則特徵／先發來源不可靠',
  }),
  Object.freeze({
    key: 'model_history',
    label: '模型同口徑歷史',
    weight: 85,
    tier: 'critical',
    blockRecommend: true,
    why: '隊伍近期攻防特徵是預期得分主輸入',
  }),
  Object.freeze({
    key: 'park',
    label: '球場係數',
    weight: 50,
    tier: 'high',
    blockRecommend: false,
    why: '影響預期得分；缺則用中性／靜態 fallback',
  }),
  Object.freeze({
    key: 'official_history',
    label: '官方戰績特徵',
    weight: 45,
    tier: 'high',
    blockRecommend: false,
    why: '對照用；正式路徑以 model_history 為主',
  }),
  Object.freeze({
    key: 'weather',
    label: '天氣',
    weight: 35,
    tier: 'medium',
    blockRecommend: false,
    why: '缺則中性天氣；非獨贏主驅動',
  }),
  Object.freeze({
    key: 'bullpen',
    label: '牛棚負荷',
    weight: 30,
    tier: 'medium',
    blockRecommend: false,
    why: '模型有牛棚特徵但可降權運行',
  }),
  Object.freeze({
    key: 'travel_rest',
    label: '旅行／休息',
    weight: 25,
    tier: 'medium',
    blockRecommend: false,
    why: '輔助訊號',
  }),
  Object.freeze({
    key: 'injuries',
    label: '傷停名單',
    weight: 20,
    tier: 'medium',
    blockRecommend: false,
    why: '常不完整；不作硬擋',
  }),
  Object.freeze({
    key: 'venue',
    label: '球場名稱',
    weight: 15,
    tier: 'low',
    blockRecommend: false,
    why: '多半隨賽程取得',
  }),
  Object.freeze({
    key: 'lineup',
    label: '確認打線',
    weight: 10,
    tier: 'low',
    blockRecommend: false,
    why: '開賽前常未公布',
  }),
  Object.freeze({
    key: 'pitcher_injury_intel',
    label: '先發傷病情報',
    weight: 8,
    tier: 'low',
    blockRecommend: false,
    why: '研究旗標，不改正式權重',
  }),
]);

const BY_KEY = Object.freeze(
  Object.fromEntries(MLB_EVIDENCE_CATALOG.map((row) => [row.key, row]))
);

function statusScore(status, meta = null) {
  if (isStatusAccepted(status, meta)) return 1;
  if (status === 'verified') return 1;
  if (status === 'partial') return 0.5;
  return 0;
}

function statusLabel(status, meta = null) {
  if (meta?.key === 'starting_pitchers' && status === 'partial') return '預定齊';
  if (status === 'verified') return '齊';
  if (status === 'partial') return '部分';
  if (status === 'stale') return '過期';
  if (status === 'conflicting') return '衝突';
  return '缺';
}

function isStatusAccepted(status, meta) {
  const accepted = meta?.acceptStatuses || ['verified'];
  return accepted.includes(status);
}

/** 該證據是否滿足推薦硬閘門 */
export function isEvidenceReadyForRecommend(item, key = item?.key) {
  const meta = BY_KEY[key];
  if (!meta?.blockRecommend) return true;
  const status = item?.status || 'missing';
  return isStatusAccepted(status, meta);
}

/**
 * @param {Array<{key:string,status:string,summary?:string,reason?:string}>} evidenceItems
 */
export function buildDataReadiness(evidenceItems = []) {
  const byEvidence = new Map(
    (Array.isArray(evidenceItems) ? evidenceItems : []).map((item) => [item.key, item])
  );

  const checklist = MLB_EVIDENCE_CATALOG.map((meta) => {
    const item = byEvidence.get(meta.key);
    const status = item?.status || 'missing';
    const score = statusScore(status, meta);
    const ready = isStatusAccepted(status, meta);
    return {
      key: meta.key,
      label: meta.label,
      weight: meta.weight,
      tier: meta.tier,
      blockRecommend: meta.blockRecommend,
      why: meta.why,
      status,
      statusLabel: statusLabel(status, meta),
      score,
      weighted: Number((meta.weight * score).toFixed(2)),
      summary: item?.summary || '',
      reason: item?.reason || null,
      usedInModel: Boolean(item?.usedInModel),
      ok: ready,
      softOk: status === 'verified' || status === 'partial',
    };
  }).sort((a, b) => b.weight - a.weight);

  const totalWeight = checklist.reduce((s, row) => s + row.weight, 0);
  const earnedWeight = checklist.reduce((s, row) => s + row.weight * row.score, 0);
  const score01 = totalWeight > 0 ? earnedWeight / totalWeight : 0;

  const missingCritical = checklist.filter(
    (row) => row.blockRecommend && !row.ok
  );
  const missingHigh = checklist.filter(
    (row) => row.tier === 'high' && row.status !== 'verified' && row.status !== 'partial'
  );

  const recommendationAllowed = missingCritical.length === 0;

  return {
    recommendationAllowed,
    score01: Number(score01.toFixed(4)),
    scorePct: Math.round(score01 * 100),
    missingCritical: missingCritical.map((row) => ({
      key: row.key,
      label: row.label,
      status: row.status,
      why: row.why,
    })),
    missingHigh: missingHigh.map((row) => ({
      key: row.key,
      label: row.label,
      status: row.status,
    })),
    checklist,
    catalogVersion: 'mlb-evidence-weight-v1',
  };
}

export function getEvidenceMeta(key) {
  return BY_KEY[key] || null;
}

/** 寫入 snapshot 用的硬閘門 key（須 verified） */
export function getMandatoryEvidenceKeys() {
  return MLB_EVIDENCE_CATALOG.filter((row) => row.blockRecommend).map((row) => row.key);
}
