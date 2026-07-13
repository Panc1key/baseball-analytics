# calendar — 賽季與提醒

計劃功能：

- `seasons.json` — 各運動賽季起迄（美東 / UTC）
- `getActiveSports(date)` — 當日哪些運動在賽季內
- `getUpcomingMilestones()` — 開幕日、全明星、季後賽等
- API：`GET /api/calendar` → 前端頂部賽季狀態條

示例（MLB 2026）：

- 例行賽：2026-03-25 ～ 2026-09-27
- 休賽：2026-10 ～ 2027-03
