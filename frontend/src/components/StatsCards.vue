<template>
  <div class="stats-row">
    <el-card v-for="item in items" :key="item.label" shadow="hover" class="stat-card">
      <div class="stat-label">{{ item.label }}</div>
      <div class="stat-value" :class="item.class">{{ item.value }}</div>
    </el-card>
  </div>
</template>

<script setup>
defineProps({
  items: { type: Array, default: () => [] },
});
</script>

<style scoped>
.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
.stat-card {
  text-align: center;
}
.stat-label {
  font-size: 13px;
  color: #909399;
  margin-bottom: 6px;
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
}
.stat-value.positive { color: #67c23a; }
.stat-value.negative { color: #f56c6c; }
</style>
