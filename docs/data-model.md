# 資料模型

`convex/schema.ts` 七張表——三張是看板資料，一張設定，兩張跟帳號與編輯提議有關，一張是聊天：

- **`epics`** — X 軸的欄。`code`（如 `DEMO-BOARD`）、`name`、`accent` 顏色鍵、`order` 決定左右順序。
- **`checkpoints`** — Y 軸的列。`kind` 是 `week` 或 `backlog`；週別存 `weekNumber` 與 `startDate`/`endDate`（ISO 日期字串）。**列的順序由日期推導**，不看 payload 給的 `order`——週次有真實日期，從日期排就不可能因為匯入時 `order` 給錯而排亂（這個錯踩過一次）。backlog 永遠在最後。
- **`tickets`** — 卡片。以 `epicId` + `checkpointId` 決定落在哪一格，`status` 是四個燈號之一。`assignee` / `dueDate` / `githubPrs` / `tag` 皆為選填。
- **`config`** — 看板設定，只有一筆文件（讀取時取第一筆）。存 `jiraBaseUrl` 與 `assigneeColors`，見下方。
- **`users`** — 帳號。`account`（唯一，有 `by_account` 索引）、`tokenHash` 與五個獨立的布林權限，見「登入與權限」。
- **`editRequests`** — 還沒被審核的編輯提議，一筆對應一張卡（或一格的排序）。只有 `permEditRequest` 的人做的編輯會落在這裡，見「編輯提議」。
- **`messages`** — 看板助理的聊天訊息，一個帳號一條對話。助理的指令也是一則訊息，帶著它的執行狀態，見「看板助理的對話」。

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
| `permWrite` | 能不能編輯（拖曳、新增、修改、刪除、點燈號），也代表能審核別人的編輯提議 |
| `permEditRequest` | 能不能**提議**編輯。選填欄位——在這個功能之前建立的帳號沒有它，讀不到就當 false |
| `permApproveRegister` | 能不能看到並處理待審註冊 |
| `permAgent` | 能不能當看板助理——讀寫聊天訊息、對別人的對話下指令。選填欄位，讀不到就當 false |

五個權限彼此獨立，任何組合都成立。只有 `permRead` 是唯讀；`permRead + permEditRequest` 看到完整的編輯介面，但每個動作變成一筆待審的提議（見下面的 `editRequests`）；`permWrite` 直接寫入，永遠不會產生提議。兩個都有的時候 `permWrite` 贏。

`permAgent` 是給機器的，而且刻意只給一件事的權力：助理帳號拿 `permRead + permAgent`，**沒有 `permWrite`、也沒有 `permEditRequest`**，所以它讀得到看板、講得出話，但改不動任何一張卡（見下面的「看板助理的對話」）。

**密碼永遠不離開瀏覽器。** hash 在前端用 Web Crypto（`crypto.subtle.digest`）算（`src/lib/auth.ts` 的 `computeTokenHash`），只有 hash 會被送出、存進 `users`、寫進 localStorage 的 `kanban.auth.v1`。所以後端沒有任何地方看得到、存得到或 log 得到明文密碼。帳號名稱是 hash 的一部分，所以正規化必須兩邊一致——前端在 hash 之前先做，後端用同一條規則再做一次。

代價講清楚：**`tokenHash` 本身就是憑證，而且固定不變。** 拿到它等於拿到那個帳號，沒有到期也不能作廢；要收回權限只能改密碼（重新 `seedUser`）或刪掉帳號。這是為了不做 session／輪替／撤銷而刻意接受的取捨（YAGNI），連線本身有 TLS 保護。

### 憑證怎麼傳、誰檢查

前端登入後把 `{ account, tokenHash }` 放進每一次 query／mutation 的 `auth` 參數。後端的關口只有一個——`convex/auth.ts`：

```
requireRead(ctx, auth)                          → permRead，否則丟 AUTH_DENIED
requireWrite(ctx, auth)                         → permWrite
requireEdit(ctx, auth)                          → permWrite 或 permEditRequest（回 user，讓 handler 自己分岔）
requirePermission(ctx, auth, "permApproveRegister")   // 或 "permAgent"
```

查不到帳號和 hash 不符回同一個答案（不告訴陌生人有哪些帳號存在）。錯誤訊息都帶 `AUTH_DENIED` 前綴，前端據此把失效的憑證清掉、退回登入頁，而不是在空看板上蓋一塊紅字。

### 註冊與審核

| 函式 | 型別 | 需要的權限 | 做什麼 |
| --- | --- | --- | --- |
| `auth:login` | query | 不需要 | 回 `invalid` / `pending` / `ok`（含 `permWrite`、`permEditRequest`、`permApproveRegister`、`permAgent`）。**刻意不丟錯**：它同時是登入表單的答案與看板持續訂閱的那個查詢。UI 不看 `permAgent`，它在那裡是為了讓助理用一次 HTTP 呼叫驗自己的憑證 |
| `auth:register` | mutation | 不需要 | 用前端算好的 hash 建帳號，五個權限**全部 false**；帳號重複拒絕 |
| `auth:pendingUsers` | query | `permApproveRegister` | 待審帳號（`permRead=false`），最舊的在前 |
| `auth:approve` | mutation | `permApproveRegister` | **只設 `permRead=true`**，不會給其他權限 |
| `auth:dismiss` | mutation | `permApproveRegister` | 刪掉那筆註冊，名字就釋放出來。已經過審的帳號拒絕刪（誤點鈴鐺不該砍掉在用的帳號） |
| `auth:seedUser` | **internal** | — | 建立／覆寫帳號，五個權限都自己指定（`permEditRequest` 與 `permAgent` 選填，不給就是 false）。第一個管理員從這裡進來 |
| `auth:deleteUser` | **internal** | — | 刪帳號，也就是撤銷的唯一途徑；順手刪掉那個人還沒被審核的編輯提議，以及他的聊天訊息（對話是用帳號名稱定位的，留著會被同名新帳號讀到） |
| `auth:listUsers` | **internal** | — | 列出帳號與權限（不回 hash） |

`permWrite`、`permEditRequest`、`permApproveRegister` 與 `permAgent` **只能從終端機給**（`auth:approve` 只會給 `permRead`），瀏覽器沒有任何路徑能把自己或別人升權：

```bash
# hash 要在外面算：sha256("kanban:<account>:<password>")
node -e 'console.log(require("crypto").createHash("sha256").update("kanban:someone:s3cret").digest("hex"))'

npx convex run auth:seedUser '{"account":"someone","tokenHash":"<64 hex>",
  "permRead":true,"permWrite":true,"permApproveRegister":true}'
# 只給提議編輯的人：
npx convex run auth:seedUser '{"account":"someone","tokenHash":"<64 hex>",
  "permRead":true,"permEditRequest":true}'
# 看板助理帳號：讀得到看板、能講話，改不動任何東西
npx convex run auth:seedUser '{"account":"agent","tokenHash":"<64 hex>",
  "permRead":true,"permAgent":true}'
npx convex run auth:listUsers
npx convex run auth:deleteUser '{"account":"someone"}'
npx convex run auth:seedUser ... --prod   # 對 production
```

### 前端的四個狀態

`AuthProvider`（`src/components/AuthProvider.tsx`）訂閱 `auth:login`，所以帳號被刪、密碼被改、權限被調整都會即時反映：`loading`（正在驗證存下來的憑證）、`anonymous`（登入／註冊畫面）、`pending`（等待審核的等候室）、`authenticated`（看板）。**看板只在 `authenticated` 掛載**——`board:get` 對壞憑證是丟錯的，而丟錯的 query 會把整頁帶走；讓看板在同一次 render 卸載，錯誤就不會浮出來。

`permWrite` 與 `permEditRequest` 都沒有的人看到的是唯讀看板：格子的「+」、卡片的點擊編輯、狀態燈號按鈕與拖曳都不會出現（`BoardActions.canEdit`）。**這只是不給誤導性的 affordance，不是防線**——防線在後端每個 handler 的 `requireWrite` / `requireEdit`。

`permEditRequest` 的人拿到的是**同一套**介面（同樣的拖曳、同樣的 modal、同樣的燈號），只有文案改成「提議…」，呼叫的 mutation 一模一樣——要不要當成提議是後端決定的。

## 公開的寫入面：`convex/board.ts` 的 `board:*`

看板可以直接編輯，所以對外開放的 mutation 不只一個。全部住在 `convex/board.ts`，**每一個都收 `auth` 並要求 `permWrite` 或 `permEditRequest`**（`requireEdit`）：有 `permWrite` 就直接寫入，只有 `permEditRequest` 就變成一筆待審的提議。護欄與欄位驗證兩條路完全一樣。

| Mutation | 做什麼 | 護欄 |
| --- | --- | --- |
| `moveTicket` | 把卡片換到另一個 checkpoint 列 | `epicId` 是「必須留在這一欄」的護欄，和卡片現在的 epic 不符就整個拒絕；目標列必須存在；卡片落在該格最後 |
| `reorderCell` | 寫入一整格的卡片順序 | 每張卡都要屬於這個 epic 與這一格；同一張卡重複列出會拒絕 |
| `createTicket` | 直接在看板上開卡 | 標題非空、ISO 日期、PR 必須是 http(s) 網址、key 唯一且不含空白；epic 與 checkpoint 必須存在 |
| `updateTicket` | 改標題／狀態／週次／負責人／日期／標籤／PR | 同上的欄位檢查；**不收 `epicId` 與 `key`**，所以改不動 |
| `deleteTicket` | 刪掉一張卡 | 卡片必須存在（UI 會要求二次確認） |

整個公開面就這些：`board:get`（要 `permRead`）、上面五個 mutation（要 `permWrite` 或 `permEditRequest`）、`editRequests:*` 的五個函式（見下一節）、`messages:*` 的十一個函式（見「看板助理的對話」）、`auth:*` 的六個函式，以及唯一不收憑證的 `staticHosting:getCurrentDeployment`（只有部署資訊，前端用它判斷有沒有新版本，登入頁也要能提示，見 architecture.md）。匯入與設定（`convex/data.ts` 的 `importBoard` / `setConfig` / `removeEpics` …）與帳號管理（`auth:seedUser` / `deleteUser` / `listUsers`）**維持 internal**，瀏覽器叫不動。

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

## 編輯提議（`editRequests` 表）

`permEditRequest` 但沒有 `permWrite` 的帳號按下的每一個編輯動作，都變成這張表裡的一列。**沒有歷史、沒有 audit log**：一筆提議只有「還在等」這一個狀態，核准、忽略、撤回三條路都是把它刪掉。

| 欄位 | 內容 |
| --- | --- |
| `requestedBy` / `account` | 提議者。`account` 是複本，讓審核清單不用一筆一筆回頭讀 `users` |
| `kind` | `create` / `update` / `delete` / `reorder` |
| `ticketId` | 目標卡片（`update`、`delete`） |
| `epicId` / `checkpointId` | 目標格子（`create` 落在哪裡、`reorder` 排哪一格） |
| `fields` | 要求的內容。`create` 放整張卡，`update` 只放改動的欄位（`null` 代表清空） |
| `before` | **第一次**碰這張卡時它長什麼樣——diff 的左邊。`create` 與 `reorder` 沒有 |
| `ticketIds` | `reorder` 要求的整格順序 |

索引只有 `by_requester`：疊加要讀「我的」，合併也要讀「我的」。審核清單直接 `take(500)` 全表，這張表天生是短的。

### 一張卡最多一筆提議：合併

同一張卡再被動一次不會長出第二列，而是併進原本那一列（`mergeChange`）：

| 已經有的 | 又做了 | 結果 |
| --- | --- | --- |
| `create` | 修改 | 一筆 `create`，欄位是最後的樣子 |
| `update` | 修改 | 一筆 `update`，欄位合併；`before` 保持第一次的值，所以 diff 永遠是「原本 → 最後」 |
| `update` | 換週次 | 同一筆 `update`（週次就是 `checkpointId` 這個欄位） |
| 任何 | 刪除 | 變成一筆 `delete` |
| `create` | 刪除 | 整筆消失（本來就還不存在） |
| 任何 | 改回原值 | 那個欄位從提議裡移除；沒有欄位剩下時整筆消失 |

`reorder` 是格子層級的，一格一筆，最後一次的排列覆蓋前一次。**不同人的提議永遠不合併**——合併只在同一個 `requestedBy` 的列之間發生。

### 提議者看到的是自己的提議

`board:get` 在回傳之前，把呼叫者自己還沒被審核的提議疊在真實資料上（`overlayTickets`）：新增的卡片出現、刪除的卡片消失、換週次與欄位改動照提議顯示，受影響的卡片帶一個 `pendingEdit` 標記（前端畫成「待審…」badge）。**別人看到的還是真實資料**，而且因為疊加在伺服器端做，重新整理不會掉。有 `permWrite` 的帳號沒有疊加——他們的寫入本來就是真的。

一張還只是提議的新卡片沒有 `tickets` 的 id，所以它用**提議自己的 id** 當 `_id`；五個 `board:*` mutation 都收這種 id（`ticketRefValidator`），前端因此不需要為「還沒存在的卡片」分出第二條路。

### 審核

| 函式 | 型別 | 需要的權限 | 做什麼 |
| --- | --- | --- | --- |
| `editRequests:list` | query | `permWrite` | 所有待審提議，含 diff（誰、哪張卡、什麼變成什麼） |
| `editRequests:mine` | query | `permEditRequest` | 自己的待審提議 |
| `editRequests:withdraw` | mutation | `permEditRequest` | 撤回自己的（別人的丟 `AUTH_DENIED`） |
| `editRequests:approve` | mutation | `permWrite` | 套用，然後刪掉那一列 |
| `editRequests:dismiss` | mutation | `permWrite` | 直接刪掉，提議者的疊加隨即消失 |

**核准走的是跟直接寫入完全同一條路**（`convex/apply.ts`），所以「被核准」和「有寫入權的人自己做」結果一致，護欄與欄位驗證也一模一樣。核准會**重新驗證**：卡片在等待期間被刪掉、epic 不對之類的情況會失敗，錯誤原因回給審核者，而且那一列**留著**讓他能改按「忽略」（mutation 失敗就整筆 rollback，這是免費的）。審核清單本身也會先提醒：目標卡片已經不在了的提議帶一行警告。

## 看板助理的對話（`messages` 表）

看板右下角的聊天泡泡背後是一張很小的表。每個帳號一條對話，助理（一個跑在終端機的 Claude Code session）讀它、回它，需要改看板時**下指令**，而指令是**使用者的瀏覽器**用**使用者自己的憑證**執行的。

**助理碰不到看板資料。** 它能叫的函式只有下面那五個 `messages:agent*` 加上 `board:get`，帳號也只有 `permRead + permAgent`。所以一條指令的後果永遠帶著使用者的權限，不是助理的：`permWrite` 的人指令直接生效，`permEditRequest` 的人得到一筆待審提議（完全沒有額外程式碼），唯讀的人被拒絕。護欄、欄位驗證與提議合併也都是人手按下去時走的那一套。

| 欄位 | 內容 |
| --- | --- |
| `account` | 對話的主人。每個人只讀得到自己的（查詢從憑證推出帳號，沒有參數可以指定別人） |
| `role` | `user` / `agent` |
| `text` | 使用者說的話，或**助理對指令的一句人話描述**（聊天視窗顯示的就是這句） |
| `command` | 只有助理的指令訊息有。五種形狀之一，見下面 |
| `status` | 指令的狀態：`pending` → `running` → `executed` / `proposed` / `failed` |
| `result` | 成功時是送出內容的摘要，失敗時是原因原文 |
| `claimedAt` | 瀏覽器認領的時間。超過 60 秒沒回報就可以被另一個分頁接手 |
| `readAt` | **助理看到它的時間**（下面「已讀」一節） |
| `handled` | **助理的收件匣旗標**：使用者的訊息進來是 false，助理的回覆一進來就是 true，指令要等結果被讀過才變 true |

索引兩個：`by_account`（讀一條對話）、`by_handled`（一次查出「所有還有事情等著」的訊息）。收件匣用**每則訊息一個 flag** 而不是游標，因為要回答的問題不只「有沒有新訊息」，還有「哪一條指令的結果還沒被看過」——游標只能表達前者。

### 已讀（`readAt`）與處理完（`handled`）是兩件事

`readAt` 是「這一列**到達助理**的時刻」，`handled` 是「助理**處理完**了」。刻意分成兩個欄位，因為那是兩個時間點：問題在一秒內被讀到，但整段對話可能還要跑好幾分鐘才算結束——合成一個欄位就只能表達其中一件，聊天視窗會變成「回完才顯示已讀」，收件匣也會在對話還沒完成時就清空。

- 誰寫：`messages:agentMarkRead`（要 `permAgent`，收 `messageIds`），由助理的 listener（`.claude/skills/board-assistant/scripts/listen.mjs`）在收到事件的同一瞬間呼叫。`agentMarkHandled` 清掉一列時如果還沒有 `readAt` 也會補上——處理完當然看過了，而且沒用 listener 的 session 也該讓使用者看到已讀。
- 前端怎麼用：`messages:thread` 回傳 `readAt`，聊天視窗在**使用者自己**的泡泡底下顯示一行小小的「已讀」。因為那是一個 subscription，訊息送出時沒有標示，助理讀到的那一刻才反應式地出現——這是使用者唯一看得出「助理真的在線上」的訊號。
- 為什麼用 id 而不是「整條對話都標已讀」：快照與 mutation 之間可能又進來一則訊息，整條標下去會讓它「已讀但沒人看過」。而且 `agentMarkRead` 會**回傳它真正標到的 id**——mutation 是交易，所以兩個同時在等的 listener 對同一則訊息只有一個標得到，另一個拿到空陣列就繼續等。認領語意是免費送的，多個助理同時值班不會回同一句話兩次。

### 助理怎麼被通知：`agentWatch`

`messages:agentWatch`（要 `permAgent`）是**還沒到達助理**的那些列，一列一個事件，最舊的在前：

| `type` | 什麼時候出現 | 附帶 |
| --- | --- | --- |
| `userMessage` | 有人說話（`role: "user"`、沒有 `readAt`） | `account`、`text`、`messageId`、`at` |
| `commandResult` | 指令走到結局（`executed` / `proposed` / `failed`，沒有 `readAt`） | 再加 `status`、`result`、`command` |

沒有 webhook，但也**不需要輪詢**：listener 用 Convex 的 WebSocket 訂閱這個 query，有人送訊息或瀏覽器回報結果時 Convex 直接推過來（本地實測 wake latency ~50ms），listener 標已讀、把事件印成 JSON、然後結束程序——「程序結束」就是通知。`account` 參數把 feed 縮到一條對話，讓正在對談的 sub-agent 只等自己這位使用者。已經 `handled` 的列不算事件，所以這個欄位加上來之前的舊訊息不會突然把人叫起來。

### 指令：五種形狀，一律用 key 指涉

`convex/schema.ts` 的 `commandValidator` 就是白名單，一一對應五個 `board:*` mutation。**卡片一律用 `key`、格子用 epic `code` + checkpoint**，不用 Convex id——id 換一個 deployment 就不一樣，key 不會。`checkpoint` 是週次數字或字串 `"backlog"`。

```jsonc
{ "kind": "moveTicket",   "key": "ABC-12", "checkpoint": 34 }
{ "kind": "reorderCell",  "epicCode": "ABC", "checkpoint": 34, "keys": ["ABC-12", "ABC-9"] }
{ "kind": "createTicket", "epicCode": "ABC", "title": "…",     // 其餘選填；沒有 checkpoint 就是 backlog
  "checkpoint": 34, "key": "…", "status": "doing", "assignee": "…",
  "dueDate": "2026-08-28", "tag": "FE", "githubPrs": ["https://…"] }
{ "kind": "updateTicket", "key": "ABC-12", "status": "done" }  // 只送要改的欄位，null 清空
{ "kind": "deleteTicket", "key": "ABC-12" }
```

key 與 code 的解析在**前端**做（`src/lib/assistant.ts` 的 `resolveCommand`），因為那裡本來就有整份看板。查不到的 key 或不存在的週次不會變成一個壞掉的呼叫，而是一筆 `failed` 加上一句人看得懂的原因，寫回訊息裡給助理讀。

### 函式面

| 函式 | 型別 | 需要的權限 | 做什麼 |
| --- | --- | --- | --- |
| `messages:send` | mutation | `permRead` | 說一句話。**問問題不是編輯**，所以門檻是讀取權 |
| `messages:thread` | query | `permRead` | 自己的整條對話（前端的訂閱來源） |
| `messages:claim` | mutation | `permRead` | 原子性地認領一則 `pending` 指令，回 `{ claimed }` |
| `messages:report` | mutation | `permRead` | 回報結果：`executed` / `proposed` / `failed` ＋原因 |
| `messages:agentWatch` | query | `permAgent` | 還沒到達助理的事件（可帶 `account` 只看一條對話）——listener 訂閱的就是它 |
| `messages:agentInbox` | query | `permAgent` | 每一條「有事情等著」的對話：新訊息數、在飛的指令數、待讀結果數 |
| `messages:agentRead` | query | `permAgent` | 讀某個帳號的整條對話（含 `readAt`、`handled`） |
| `messages:agentReply` | mutation | `permAgent` | 回一句話（進來就是 handled） |
| `messages:agentCommand` | mutation | `permAgent` | 下一條指令（`description` ＋ `command`） |
| `messages:agentMarkRead` | mutation | `permAgent` | 標已讀並認領（收 `messageIds`，回真正標到的 id） |
| `messages:agentMarkHandled` | mutation | `permAgent` | 「這條對話我處理完了」。**還在飛的指令不會被清掉**，順手補上 `readAt` |

助理那半邊是**公開函式**而不是 internal，因為它跑在沒有 Convex 憑證的容器裡：它跟瀏覽器一樣送 `{ account, tokenHash }`——一次性的呼叫打 `POST /api/query` 與 `/api/mutation`，等訊息的時候用 Convex 的 WebSocket 訂閱 `agentWatch`。做法與紅線寫在 `.claude/skills/board-assistant/SKILL.md`。**憑證不進版控**——那份 skill 只說從環境變數讀，沒有寫任何 hash。

`claim` 是獨立的 mutation，這是整個機制唯一真正微妙的地方：Convex 的 mutation 是可序列化的交易，所以兩個分頁讀到同一則 `pending` 時只有一個拿到 `claimed: true`。把它塞進執行器的「讀對話→執行」裡就會有一段兩邊都以為指令是自己的空窗，使用者會看到卡片被移兩次——或者兩筆提議要審。
