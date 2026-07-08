<template>
  <el-table :data="bets" stripe empty-text="尚無投注紀錄，在推薦頁點擊記錄即可">
    <el-table-column label="時間" width="160">
      <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
    </el-table-column>
    <el-table-column prop="league" label="聯盟" width="70" />
    <el-table-column prop="pick" label="選擇" min-width="140" />
    <el-table-column prop="market" label="市場" width="80" />
    <el-table-column label="注額" width="70">
      <template #default="{ row }">${{ row.stake }}</template>
    </el-table-column>
    <el-table-column label="賠率" width="70">
      <template #default="{ row }">{{ row.odds_decimal?.toFixed(2) }}</template>
    </el-table-column>
    <el-table-column label="結果" width="90">
      <template #default="{ row }">
        <el-tag :type="resultTag(row.result)" size="small">{{ resultLabel(row.result) }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="盈虧" width="80">
      <template #default="{ row }">
        <span v-if="row.profit != null" :class="row.profit >= 0 ? 'win' : 'loss'">
          {{ row.profit >= 0 ? '+' : '' }}{{ row.profit?.toFixed(2) }}
        </span>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="200" fixed="right">
      <template #default="{ row }">
        <template v-if="row.result === 'pending'">
          <el-button size="small" type="success" @click="$emit('settle', row, 'win')">贏</el-button>
          <el-button size="small" type="danger" @click="$emit('settle', row, 'loss')">輸</el-button>
          <el-button size="small" @click="$emit('settle', row, 'push')">走水</el-button>
        </template>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup>
defineProps({ bets: { type: Array, default: () => [] } });
defineEmits(['settle']);

function formatTime(raw) {
  if (!raw) return '';
  const d = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function resultTag(r) {
  return { win: 'success', loss: 'danger', push: 'info', pending: 'warning' }[r] || 'info';
}
function resultLabel(r) {
  return { win: '贏', loss: '輸', push: '走水', pending: '待結' }[r] || r;
}
</script>

<style scoped>
.win { color: #67c23a; font-weight: 600; }
.loss { color: #f56c6c; font-weight: 600; }
</style>
