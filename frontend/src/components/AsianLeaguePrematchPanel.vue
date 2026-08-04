<template>
  <section class="asian-panel">
    <header class="toolbar">
      <div>
        <h2 class="panel-title">日職／韓職初盤</h2>
        <p class="panel-sub">
          泊松 + Elo 舊管線 · 與 MLB 鎖定 B 分開 · 紙上研究
        </p>
      </div>
      <div class="toolbar-right">
        <el-radio-group v-model="league" size="small">
          <el-radio-button label="">全部</el-radio-button>
          <el-radio-button label="NPB">日職</el-radio-button>
          <el-radio-button label="KBO">韓職</el-radio-button>
        </el-radio-group>
        <el-button size="small" plain :loading="loading" @click="reload">
          重新載入
        </el-button>
      </div>
    </header>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="note"
      title="基線提醒（2026-04～07 紙上）"
      description="NPB 均注獨贏目前偏負；KBO 獨贏門檻後略正但樣本少。勿照抄 MLB 鎖定 B。和局／延長結算需對齊你的庄。"
    />

    <DailySlatePanel
      ref="slateRef"
      sport="baseball"
      :league="league || ''"
      :asian-only="!league"
      :auto-load="true"
    />
  </section>
</template>

<script setup>
import { ref } from 'vue';
import DailySlatePanel from './DailySlatePanel.vue';

const league = ref('');
const loading = ref(false);
const slateRef = ref(null);

async function reload() {
  loading.value = true;
  try {
    await slateRef.value?.loadSlate?.();
  } finally {
    loading.value = false;
  }
}

defineExpose({ reload });
</script>

<style scoped>
.asian-panel {
  margin-top: 8px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}
.toolbar-right {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.panel-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 650;
}
.panel-sub {
  margin: 4px 0 0;
  color: #666;
  font-size: 0.85rem;
}
.note {
  margin-bottom: 12px;
}
</style>
