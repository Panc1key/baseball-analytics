<template>
  <section v-if="health" class="source-health" :class="`state-${health.status}`">
    <header>
      <strong>MLB 資料源健康</strong>
      <el-tag :type="tagType" size="small">{{ statusLabel }}</el-tag>
    </header>
    <div class="checks">
      <span v-for="item in health.checks" :key="item.key" :class="`check-${item.status}`">
        {{ item.status === 'passed' ? '通過' : item.status === 'warning' ? '隔離' : '失敗' }}
        · {{ label(item.key) }}
      </span>
    </div>
    <small>舊錯誤快照保留審計但不得進入模型；資料源 failed 時禁止模型部署。</small>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { getMlbSourceHealth } from '../api/index.js';

const health = ref(null);
const tagType = computed(() =>
  health.value?.status === 'passed'
    ? 'success'
    : health.value?.status === 'warning'
      ? 'warning'
      : 'danger'
);
const statusLabel = computed(() => ({
  passed: '全部通過',
  warning: '已隔離舊資料',
  failed: '來源阻斷',
}[health.value?.status] || '未檢查'));

const labels = {
  completed_scores: '完賽比分',
  pit_odds_coverage: 'PIT 賠率覆蓋',
  post_start_odds_label: '開賽後盤標記',
  truth_snapshot_time: 'Truth 時點',
  feature_outcome_consistency: '特徵標籤一致',
  deployment_training_regime: '部署訓練範圍',
  injury_evidence_v2_semantics: '傷兵語意 v2',
  truth_model_input_replay: 'Truth 輸入可重放',
  legacy_injury_evidence_quarantine: '舊傷兵快照',
};

function label(key) {
  return labels[key] || key;
}

async function loadHealth() {
  const result = await getMlbSourceHealth();
  health.value = result.data || null;
}

onMounted(loadHealth);
</script>

<style scoped>
.source-health { display: grid; gap: 8px; padding: 12px; border: 1px solid #e5e6eb; border-radius: 8px; background: #fff; }
.state-failed { border-color: #ffccc7; }
.state-warning { border-color: #ffe58f; }
header, .checks { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
header { justify-content: space-between; }
.checks, small { color: #4e5969; font-size: 12px; }
.check-failed { color: #cf1322; }
.check-warning { color: #d48806; }
.check-passed { color: #389e0d; }
</style>
