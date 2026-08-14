# 當前進度

_更新於 2026-08-14。_

## 已完成

- 矩陣看板唯讀呈現：資料從 Convex 讀出、渲染 Epic × 週 矩陣
- 時間區間 lazy loading（首次近 8 週，往上逐批載入）
- 前端搜尋與狀態／負責人多選篩選
- 本週列高亮與逾期標籤（皆由日期推導，不需手動維護）
- 匯入管線：payload 驗證、冪等 upsert、`pruneEpics` 全量同步
- 從 Jira 匯入的流程整理成 skill（`.claude/skills/jira-board-import/`）
- Convex 靜態託管部署（production / dev 兩個 deployment）

## 尚未實作

- 權限控管
- 新增／編輯卡片（目前只能走匯入）
- 拖曳卡片
- 點卡片開詳情 modal
- Jira 同步自動化（目前由 Agent 依 skill 手動執行）
