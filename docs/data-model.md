# 資料模型

`convex/schema.ts` 四張表——三張是看板資料，一張是設定：

- **`epics`** — X 軸的欄。`code`（如 `DEMO-BOARD`）、`name`、`accent` 顏色鍵、`order` 決定左右順序。
- **`checkpoints`** — Y 軸的列。`kind` 是 `week` 或 `backlog`；週別存 `weekNumber` 與 `startDate`/`endDate`（ISO 日期字串）。**列的順序由日期推導**，不看 payload 給的 `order`——週次有真實日期，從日期排就不可能因為匯入時 `order` 給錯而排亂（這個錯踩過一次）。backlog 永遠在最後。
- **`tickets`** — 卡片。以 `epicId` + `checkpointId` 決定落在哪一格，`status` 是四個燈號之一。`assignee` / `dueDate` / `githubPrs` / `tag` 皆為選填。
- **`config`** — 看板設定，只有一筆文件（讀取時取第一筆）。存 `jiraBaseUrl` 與 `assigneeColors`，見下方。

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

注意 `weekNumber` 是團隊自己的 checkpoint 編號，**不是 ISO 週號**，而且一週的區間是週日到週六（例如 W32 = 2026-08-09 ~ 2026-08-15）——所以編號用存的，不用算的，換算一律走 `npm run week`。

**逾期也是算出來的。** 卡片沒有 `isOverdue` 欄位；`isOverdue()` 判斷 `dueDate` 早於今天且狀態不是 `done`，所以紅色標籤不會過期失準。

## 看板設定（`config` 表）

有兩件事屬於「這個 deployment 怎麼設定」而不是「看板上有什麼」，所以存在 Convex 而不是寫在程式裡——改它們不需要重新建置、不需要重新部署前端：

| 欄位 | 內容 |
| --- | --- |
| `jiraBaseUrl` | Jira browse 根網址，例如 `https://example.atlassian.net/browse`。卡片的 key 連到 `<jiraBaseUrl>/<KEY>`；**沒設定時 key 就是純文字，不會變成連結**（不給死連結）。 |
| `assigneeColors` | 負責人姓名 → 頭像顏色（hex），例如 `{ "Some Person": "#7c2d12" }`。key 要和票上的 `assignee` **完全一致**。 |

寫入只有 internal 的 `data:setConfig`，從終端機對指定 deployment 執行（沒有新增任何公開寫入端點）：

```bash
npx convex run data:setConfig '{"jiraBaseUrl":"https://example.atlassian.net/browse"}'
npx convex run data:setConfig '{"assigneeColors":{"Some Person":"#7c2d12","Other Person":"#1e3a8a"}}'
npx convex run data:getConfig            # 讀回來確認存了什麼
npx convex run data:setConfig ... --prod  # 對 production 設定
```

只有帶到的欄位會變，所以上面兩行互不干擾。但 `assigneeColors` 一給就是**整份取代**（這樣才能移除某個人），要改一個人也得把完整名單一起送。

設定隨 `board:get` 一起回傳，不另開一個 query：它是一份每張卡片都要用的小文件，看板本來就只維持一個 subscription；分成兩個 query 會多一個載入狀態，卡片也會先畫成沒有連結、再重畫一次。前端把它放進 context（`BoardConfigProvider`），卡片直接讀，不用一路傳 props。

## 公開的寫入面：`convex/board.ts` 的 `board:*`

看板現在可以直接編輯，所以對外開放的 mutation 不只一個了。全部住在 `convex/board.ts`：

| Mutation | 做什麼 | 護欄 |
| --- | --- | --- |
| `moveTicket` | 把卡片換到另一個 checkpoint 列 | `epicId` 是「必須留在這一欄」的護欄，和卡片現在的 epic 不符就整個拒絕；目標列必須存在；卡片落在該格最後 |
| `reorderCell` | 寫入一整格的卡片順序 | 每張卡都要屬於這個 epic 與這一格；同一張卡重複列出會拒絕 |
| `createTicket` | 直接在看板上開卡 | 標題非空、ISO 日期、PR 必須是 http(s) 網址、key 唯一且不含空白；epic 與 checkpoint 必須存在 |
| `updateTicket` | 改標題／狀態／週次／負責人／日期／標籤／PR | 同上的欄位檢查；**不收 `epicId` 與 `key`**，所以改不動 |
| `deleteTicket` | 刪掉一張卡 | 卡片必須存在（UI 會要求二次確認） |

唯讀的 query 有 `board:get` 與 `staticHosting:getCurrentDeployment`（前端用它判斷有沒有新版本部署，見 architecture.md）。匯入與設定（`convex/data.ts` 的 `importBoard` / `setConfig` / `removeEpics` …）**維持 internal**，瀏覽器叫不動。

這些 mutation **全部沒有認證**——看板前面沒有登入機制，任何打得開網站的人都能新增、修改、刪除卡片。這是為了「直接在看板上編輯」刻意接受的取捨；正因為如此，每個 handler 的驗證跟匯入一樣嚴，共用的檢查住在 `convex/validation.ts`。真要收斂權限，就從這幾個 handler 開始加檢查。

**payload 仍然是事實來源。** 在看板上做的修改不會回寫 Jira，也不比 payload 權威：對某個 epic 做一次完整重新匯入時，`title` / `status` / `assignee` / `dueDate` / `tag` / `githubPrs` 與所在週次都會被 payload 蓋回去；帶 `pruneEpics` 的匯入還會**刪掉** payload 沒有提到的卡片——包含在看板上手動建立的那些（`LOCAL-*`）。要保留手動的調整，就把它寫進 payload。

### 卡片不能換 Epic，也不能改 key

`updateTicket` 根本不收 `epicId`：一張卡屬於哪個專案來自 Jira，看板讓它悄悄換欄位會讓矩陣說謊（拖曳跨欄同樣被拒絕）。`key` 也不收，因為匯入是拿 key 比對的，改掉會讓這張卡在下次匯入時被當成新卡再建一次。

手動建立的卡片沒有對應的 Jira issue，key 留空就會拿到 `LOCAL-<n>`（`n` 是現有 `LOCAL-` 編號的最大值 +1，刪掉不會回收），一眼就看得出它不是 Jira 來的。要對上真實的 issue 就自己填 key，重複會被拒絕。

### 格子內的排序

`tickets.order` 是卡片在自己那一格裡的位置（0 起算）。它是選填的，因為沒有任何匯入會設定它：

- 顯示規則是「**有 `order` 的照 `order` 排，沒有的照建立時間排在後面**」（`src/lib/board.ts` 的 `sortCellTickets`），所以從來沒被拖過的格子跟以前長得一樣。
- 只要有卡片被放進某一格（`moveTicket` / `createTicket` / `updateTicket` 換週次），那一格會順手被編號 0..n-1，**而且維持當下看到的順序**——不編號的話，新卡片拿到 `max(order)+1` 反而會排在那些「沒有 order」的卡片前面，看起來就不是落在最後。沒人動過的格子不會被編號。
- `reorderCell` 一次寫入整格的順序（前端送完整的 id 陣列），所以重放同一個請求結果一樣。拖曳過程中卡片的位移是 dnd-kit 的 transform，放手才寫一次。
- **匯入不動 `order`**：`importBoard` 寫入的欄位裡沒有它，所以手動排過的順序在之後的補充匯入後還在。新匯入的卡片沒有 `order`，排在該格已排序卡片的後面。
