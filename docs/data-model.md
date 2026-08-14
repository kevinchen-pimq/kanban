# 資料模型

`convex/schema.ts` 三張表：

- **`epics`** — X 軸的欄。`code`（如 `DEMO-BOARD`）、`name`、`accent` 顏色鍵、`order` 決定左右順序。
- **`checkpoints`** — Y 軸的列。`kind` 是 `week` 或 `backlog`；週別存 `weekNumber` 與 `startDate`/`endDate`（ISO 日期字串）。**列的順序由日期推導**，不看 payload 給的 `order`——週次有真實日期，從日期排就不可能因為匯入時 `order` 給錯而排亂（這個錯踩過一次）。backlog 永遠在最後。
- **`tickets`** — 卡片。以 `epicId` + `checkpointId` 決定落在哪一格，`status` 是四個燈號之一。`assignee` / `dueDate` / `githubPrs` / `tag` 皆為選填。

## 狀態燈號

| 燈號 | 值 | 涵蓋 |
| --- | --- | --- |
| 灰 | `todo` | To Do / Backlog |
| 藍 | `doing` | Doing |
| 黃 | `testing` | Test and Review / Dev Done |
| 綠 | `done` | Dev Test Done / Done |

Jira 狀態名稱 → 燈號的完整對應表在 `.claude/skills/jira-board-import/scripts/jira-status.mjs`。

## 兩個刻意的設計決定

**「本週」是算出來的，不是存的。** checkpoint 只存起訖日期，`src/lib/board.ts` 的 `describeCheckpoints()` 用今天的日期判斷每一列的相對位置（`current` / `previous` / `next` / `past` / `future` / `backlog`），看板據此把本週那一列標成靛藍色左邊框並淡染背景。所以每週不需要手動改資料。相鄰關係是用日期距離推出來的，即使中間缺了某一週，判斷仍然正確。

注意 `weekNumber` 是團隊自己的 checkpoint 編號，**不是 ISO 週號**（W31 對應的 ISO 週其實是 32），而且一週的區間是週二到週一——所以編號用存的，不用算的。

**逾期也是算出來的。** 卡片沒有 `isOverdue` 欄位；`isOverdue()` 判斷 `dueDate` 早於今天且狀態不是 `done`，所以紅色標籤不會過期失準。
