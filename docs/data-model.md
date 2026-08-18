# 資料模型

`convex/schema.ts` 五張表——三張是看板資料，一張設定，一張使用者：

- **`epics`** — X 軸的欄。`code`（如 `DEMO-BOARD`）、`name`、`accent` 顏色鍵、`order` 決定左右順序。
- **`checkpoints`** — Y 軸的列。`kind` 是 `week` 或 `backlog`；週別存 `weekNumber` 與 `startDate`/`endDate`（ISO 日期字串）。**列的順序由日期推導**，不看 payload 給的 `order`——週次有真實日期，從日期排就不可能因為匯入時 `order` 給錯而排亂（這個錯踩過一次）。backlog 永遠在最後。
- **`tickets`** — 卡片。以 `epicId` + `checkpointId` 決定落在哪一格，`status` 是四個燈號之一。`assignee` / `dueDate` / `githubPrs` / `tag` 皆為選填。
- **`config`** — 看板設定，只有一筆文件（讀取時取第一筆）。存 `jiraBaseUrl` 與 `assigneeColors`，見下方。
- **`users`** — 帳號。`account`（唯一，有 `by_account` 索引）、`tokenHash` 與三個獨立的布林權限，見「登入與權限」。

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

## 登入與權限（`users` 表）

看板前面有一層帳號密碼登入。它刻意做得很小——**沒有 session、沒有到期、沒有換密碼、沒有撤銷 token**：

| 欄位 | 內容 |
| --- | --- |
| `account` | 帳號名稱，唯一。存進來之前一律 `trim().toLowerCase()`，長度 3–32、只收英數字與 `.` `-` `_`（`convex/auth.ts` 的 `cleanAccount`） |
| `tokenHash` | `sha256("kanban:<account>:<password>")` 的 64 位小寫十六進位字串 |
| `permRead` | 能不能讀看板。**false 就是「註冊了，還沒過審」** |
| `permWrite` | 能不能編輯（拖曳、新增、修改、刪除、點燈號） |
| `permApproveRegister` | 能不能看到並處理待審註冊 |

**密碼永遠不離開瀏覽器。** hash 在前端用 Web Crypto（`crypto.subtle.digest`）算（`src/lib/auth.ts` 的 `computeTokenHash`），只有 hash 會被送出、存進 `users`、寫進 localStorage 的 `kanban.auth.v1`。所以後端沒有任何地方看得到、存得到或 log 得到明文密碼。帳號名稱是 hash 的一部分，所以正規化必須兩邊一致——前端在 hash 之前先做，後端用同一條規則再做一次。

代價講清楚：**`tokenHash` 本身就是憑證，而且固定不變。** 拿到它等於拿到那個帳號，沒有到期也不能作廢；要收回權限只能改密碼（重新 `seedUser`）或刪掉帳號。這是為了不做 session／輪替／撤銷而刻意接受的取捨（YAGNI），連線本身有 TLS 保護。

### 憑證怎麼傳、誰檢查

前端登入後把 `{ account, tokenHash }` 放進每一次 query／mutation 的 `auth` 參數。後端的關口只有一個——`convex/auth.ts`：

```
requireRead(ctx, auth)                          → permRead，否則丟 AUTH_DENIED
requireWrite(ctx, auth)                         → permWrite
requirePermission(ctx, auth, "permApproveRegister")
```

查不到帳號和 hash 不符回同一個答案（不告訴陌生人有哪些帳號存在）。錯誤訊息都帶 `AUTH_DENIED` 前綴，前端據此把失效的憑證清掉、退回登入頁，而不是在空看板上蓋一塊紅字。

### 註冊與審核

| 函式 | 型別 | 需要的權限 | 做什麼 |
| --- | --- | --- | --- |
| `auth:login` | query | 不需要 | 回 `invalid` / `pending` / `ok`（含 `permWrite`、`permApproveRegister`）。**刻意不丟錯**：它同時是登入表單的答案與看板持續訂閱的那個查詢 |
| `auth:register` | mutation | 不需要 | 用前端算好的 hash 建帳號，三個權限**全部 false**；帳號重複拒絕 |
| `auth:pendingUsers` | query | `permApproveRegister` | 待審帳號（`permRead=false`），最舊的在前 |
| `auth:approve` | mutation | `permApproveRegister` | **只設 `permRead=true`**，不會給其他權限 |
| `auth:dismiss` | mutation | `permApproveRegister` | 刪掉那筆註冊，名字就釋放出來。已經過審的帳號拒絕刪（誤點鈴鐺不該砍掉在用的帳號） |
| `auth:seedUser` | **internal** | — | 建立／覆寫帳號，三個權限都自己指定。第一個管理員從這裡進來 |
| `auth:deleteUser` | **internal** | — | 刪帳號，也就是撤銷的唯一途徑 |
| `auth:listUsers` | **internal** | — | 列出帳號與權限（不回 hash） |

`permWrite` 與 `permApproveRegister` **只能從終端機給**，瀏覽器沒有任何路徑能把自己或別人升權：

```bash
# hash 要在外面算：sha256("kanban:<account>:<password>")
node -e 'console.log(require("crypto").createHash("sha256").update("kanban:someone:s3cret").digest("hex"))'

npx convex run auth:seedUser '{"account":"someone","tokenHash":"<64 hex>",
  "permRead":true,"permWrite":true,"permApproveRegister":true}'
npx convex run auth:listUsers
npx convex run auth:deleteUser '{"account":"someone"}'
npx convex run auth:seedUser ... --prod   # 對 production
```

### 前端的四個狀態

`AuthProvider`（`src/components/AuthProvider.tsx`）訂閱 `auth:login`，所以帳號被刪、密碼被改、權限被調整都會即時反映：`loading`（正在驗證存下來的憑證）、`anonymous`（登入／註冊畫面）、`pending`（等待審核的等候室）、`authenticated`（看板）。**看板只在 `authenticated` 掛載**——`board:get` 對壞憑證是丟錯的，而丟錯的 query 會把整頁帶走；讓看板在同一次 render 卸載，錯誤就不會浮出來。

`permWrite=false` 的人看到的是唯讀看板：格子的「+」、卡片的點擊編輯、狀態燈號按鈕與拖曳都不會出現（`BoardActions.canWrite`）。**這只是不給誤導性的 affordance，不是防線**——防線在後端每個 handler 的 `requireWrite`。

## 公開的寫入面：`convex/board.ts` 的 `board:*`

看板可以直接編輯，所以對外開放的 mutation 不只一個。全部住在 `convex/board.ts`，**每一個都收 `auth` 並要求 `permWrite`**：

| Mutation | 做什麼 | 護欄 |
| --- | --- | --- |
| `moveTicket` | 把卡片換到另一個 checkpoint 列 | `epicId` 是「必須留在這一欄」的護欄，和卡片現在的 epic 不符就整個拒絕；目標列必須存在；卡片落在該格最後 |
| `reorderCell` | 寫入一整格的卡片順序 | 每張卡都要屬於這個 epic 與這一格；同一張卡重複列出會拒絕 |
| `createTicket` | 直接在看板上開卡 | 標題非空、ISO 日期、PR 必須是 http(s) 網址、key 唯一且不含空白；epic 與 checkpoint 必須存在 |
| `updateTicket` | 改標題／狀態／週次／負責人／日期／標籤／PR | 同上的欄位檢查；**不收 `epicId` 與 `key`**，所以改不動 |
| `deleteTicket` | 刪掉一張卡 | 卡片必須存在（UI 會要求二次確認） |

整個公開面就這些：`board:get`（要 `permRead`）、上面五個 mutation（要 `permWrite`）、`auth:*` 的六個函式，以及唯一不收憑證的 `staticHosting:getCurrentDeployment`（只有部署資訊，前端用它判斷有沒有新版本，登入頁也要能提示，見 architecture.md）。匯入與設定（`convex/data.ts` 的 `importBoard` / `setConfig` / `removeEpics` …）與帳號管理（`auth:seedUser` / `deleteUser` / `listUsers`）**維持 internal**，瀏覽器叫不動。

**認證過不等於可信任。** `requireWrite` 只回答「這個人有沒有編輯權」，不回答「這份資料合不合理」，所以每個 handler 的欄位驗證跟匯入一樣嚴，共用的檢查住在 `convex/validation.ts`。

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
