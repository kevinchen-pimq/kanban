# 當前進度

_更新於 2026-08-23。_

## 已完成

- 矩陣看板呈現：資料從 Convex 讀出、渲染 Epic × 週 矩陣
- 時間區間 lazy loading（首次近 8 週，往上逐批載入）
- 前端搜尋與 Epic／狀態／負責人多選篩選；Epic 篩選會把整欄從矩陣裡拿掉
- 三個篩選的選擇存在 localStorage（`kanban.filters.v1`）並在重新載入時還原，
  看板上已不存在的 epic／負責人會被安靜丟掉；搜尋字串刻意不記憶
- 本週列高亮與逾期標籤（皆由日期推導，不需手動維護）
- 左上角落格的「本週」按鈕：把本週那一列捲回欄位標題正下方，和開場自動捲動
  共用同一段位移計算（`src/lib/scroll.ts`）
- 卡片上的 Jira 連結：站台網址存在 Convex 的 `config` 表（`data:setConfig`），
  沒設定時 key 就是純文字
- 每位負責人一個固定顏色的圓形頭像：現有成員的顏色在 `config.assigneeColors`
  手動指定，名單外的人退回姓名 hash；卡片與篩選選單一致
- **拖曳卡片改週次**：卡片可以拖到同一個 Epic 欄位的其他 checkpoint 列（含
  backlog）；拖到別的 Epic 欄位會標紅並拒絕，因為移動只改交付週次、不換專案。
  拖曳過程中畫面底部會出現**暫存區**，可以先把卡片停在那裡、捲到目標週次再拖
  出去放；停在暫存區的卡片還沒有被移動，只有放進格子時才會寫入。跨格拖曳一律
  落在目標格的最後。
- **同一格內拖曳排序**：位置存在 `tickets.order`，放手才寫一次（`reorderCell`）。
  沒有 `order` 的卡片（匯入來的）照建立時間排在後面，所以沒被拖過的格子跟以前
  一樣；匯入不會覆寫手動排好的順序（見 data-model.md）。
- **在看板上新增／編輯／刪除卡片**：格子 hover 出現「+」開表單（Epic 與週次已帶
  好），點卡片開同一個表單編輯，刪除要二次確認。Epic 與 Key 唯讀。手動建立的卡片
  沒填 key 就給 `LOCAL-<n>`，**完整重新匯入（pruneEpics）會把它刪掉**。
- **點狀態燈號循環狀態**：todo → doing → testing → done → todo，畫面立刻更新，
  停手 1 秒後才寫一次（連點只產生一次寫入）；離開頁面時用 keepalive HTTP 請求
  補送，不會因為導覽把最後一下弄丟。
- 部署新版本時，開著看板的頁面會跳出「看板有新版本」提示，可以直接重新載入
  （靠 static-hosting component 的 deployment query，不會在初次載入時誤跳）
- **帳號密碼登入與權限控管**：`users` 表存 `sha256("kanban:<account>:<password>")`
  （hash 在瀏覽器用 Web Crypto 算，明文密碼不離開瀏覽器），前端把
  `{ account, tokenHash }` 當 `auth` 參數送進每一次呼叫，`convex/auth.ts` 是唯一
  的關口：讀要 `permRead`、寫要 `permWrite`。註冊是公開的，但新帳號五個權限都是
  false，要有 `permApproveRegister` 的人從 header 的鈴鐺（有人在等就亮紅點）按
  通過才拿到讀取權；`permWrite` 只能用 internal 的 `auth:seedUser` 給。
  沒有編輯權也沒有提議權的人看到唯讀看板（沒有「+」、不能拖、燈號不可點）。
  刻意不做的：改密碼、session 到期、撤銷 token——見 data-model.md 的取捨說明。
- **提議編輯（`permEditRequest`）**：有這個權限但沒有 `permWrite` 的帳號拿到完整的
  編輯介面（拖曳換週次／排序、新增、修改、刪除、點燈號），但每個動作寫進
  `editRequests` 而不是看板。`board:get` 會把提議者自己的待審提議疊在真實資料上
  （新增的出現、刪除的消失、改動照提議顯示，卡片帶「待審…」badge），所以重新
  整理不會掉，別人也完全看不到。同一張卡的多次操作會**合併成一筆**（規則見
  data-model.md），提議者可以自己撤回。有 `permWrite` 的人在鈴鐺裡看到待審編輯，
  每一列直接攤開 diff，按「核准」走的是跟直接寫入完全同一條路徑（`convex/apply.ts`），
  核准會重新驗證、失敗時把原因給審核者並保留該筆讓他改按「忽略」。權限只能用
  internal 的 `auth:seedUser` 給，註冊審核通過仍然只給 `permRead`。
- **看板助理聊天（FAB ＋ `messages` 表 ＋ agent skill）**：右下角的泡泡打開一個
  對話視窗，訊息存在 Convex，一個帳號一條對話（別人的看不到）。對話的另一端是
  一個 agent（另一個 session 的 Claude Code），它拿 `permRead + permAgent` 的帳號，
  透過 HTTP 打 `messages:agent*` 與 `board:get`——**它碰不到看板資料**。要改看板時
  它下一條指令（五種形狀之一，卡片一律用 key 指涉），由**使用者的瀏覽器**用
  **使用者自己的憑證**跑那五個 `board:*` mutation，所以 `permWrite` 的人指令直接
  生效、只有 `permEditRequest` 的人得到一筆待審提議（badge 與審核流程完全沿用），
  唯讀的人被拒絕，全部不需要額外程式碼。指令由 `messages:claim` 原子性認領，開兩個
  分頁只會執行一次；執行器掛在一直存在的 FAB 上，所以把視窗關掉也不會卡住指令，
  有新回覆時 FAB 亮紅點。失敗（key 不存在、週次不存在、驗證不過）會把原因寫回訊息
  給 agent 讀。agent 端的做法與紅線在 `.claude/skills/board-assistant/SKILL.md`。
- **助理的即時監聽與已讀**：agent 端不再輪詢——`messages:agentWatch` 是「還沒讀到的
  事件」（新訊息／指令結果兩種），`scripts/listen.mjs` 用 WebSocket 訂閱它、阻塞到有
  事件、標已讀後印出 JSON 就結束程序，所以 main agent 只要把它丟到背景 task 就會被
  喚醒（實測 ~50ms），一條對話派一個 sub-agent（skill 的「The duty loop」）。訊息多了
  `readAt`（**已讀 ≠ 處理完**：`handled` 還是收件匣旗標），聊天視窗在使用者自己的泡泡
  底下反應式地長出「已讀」小字。`agentMarkRead` 回傳真正標到的 id，所以多個 listener
  同時等也只有一個會接手同一則訊息。
- **助理的值班機制（standby、exclude、escalation）**：main agent 開工先確認
  `node_modules`／環境變數／`auth:login`，然後預熱**兩個 standby sub-agent**，有對話
  進來用 `SendMessage` 交給待命者並立刻補一個新的（省掉讀 skill 的冷啟動）。交出去的
  帳號同時進主 listener 的 `--exclude` 與 `listen.mjs --escalate <帳號…> --grace 5`
  ——escalation 模式訂閱同一個 `agentWatch` 但**不標已讀、不認領**，新訊息過了 grace
  還沒有 `readAt` 就印一個 `type: "escalation"` 事件叫醒 main agent（sub-agent 死掉的
  對話不會被放生）。sub-agent 則自己用 `--account` 監看它那條對話的後續訊息，結束時
  `agentMarkHandled` 並回報。判定只讀 `readAt`，所以後端沒有任何改動。skill 也明文
  寫了助理**可讀** Jira／GitHub PR、**不可寫**（不 transition、不留言、不 merge）。
- **預排下週（`board:addNextWeek`）**：最後一個週次列下面有一條低調的整寬列
  「＋ 預排 W34（08/23 - 08/29）」，標籤由看板資料推導，按一下就長出那一列，
  affordance 跟著移到新列下面（所以可以一直往後排）。**日期由伺服器從最新週次
  推導**（各 +7 天、週次 +1），前端只送「哪一週」——這也是幂等的來源：連點兩下或
  兩個分頁同時按都只長一列，跳週的請求會被拒絕。新列對拖曳（含暫存區）、編輯
  modal 的週次下拉都是透明的；「回到本週」仍然指含今天的那一列。唯讀帳號看不到
  這個 affordance，**只有 `permEditRequest` 的人是直接建立、不轉成提議**（週次列是
  日期推導的結構而不是內容，理由見 data-model.md），把卡片拖進新列照舊變提議。
  重新匯入不會刪掉這些列（`importBoard` 對 checkpoints 只 upsert）。
- **進度追蹤與通知（`notifications` ＋ `reports` 表 ＋ tracker skill）**：header
  多一個通知鈴鐺（跟審核鈴鐺同一套視覺），列出屬於自己的通知：`progress`（進度）、
  `report`（週報）、`info`（通知）三種 kind，可以帶連結與卡片 key。另一端是一個
  排程 agent（Routine 定時開新 session），帳號拿
  `permRead + permEditRequest + permTracker`、**永遠沒有 `permWrite`**，所以它想改
  看板時打的是同一組 `board:*` mutation，後端那個分岔自動把它變成一筆待審提議
  ——**沒有為它開任何寫入路徑**（`board.ts`／`apply.ts`／`editRequests.ts`／
  `messages.ts` 的行為零改動）。通知半邊是新的 `notifications:*` 八個函式：使用者
  那半（`mine`／`dismiss`）要 `permRead`，tracker 那半（`trackerSend`／
  `trackerBroadcast`／`trackerPendingRechecks`／`trackerResolveRecheck`／
  `trackerReportUploadUrl`／`trackerPublishReport`）要 `permTracker`。
  三個要記住的語意：**同一個人的 `progress` 通知會就地合併**（不會越積越多、也不
  會因為更新跳到最上面）；**關掉 `progress` 通知等於請 tracker 複查**（進
  `recheckPending` 佇列，下一輪巡邏處理完才刪掉，所以「關掉」≠「處理完」）；
  **一個週次只能發一份週報**（`reports.weekNumber` 重複會被拒絕，比照
  `addNextWeek` 的幂等設計，Monday routine 跑兩次不會廣播兩次）。通知列不是歷史
  紀錄，是「還活著的工作狀態」（政策寫在 schema 與 data-model.md）。週報是一份
  HTML，用 `upload-report.mjs` 上傳到 Convex storage 後把連結廣播給所有
  `permRead` 的人。卡片的 `assignee` 要對到可以通知的帳號靠 `config.assigneeAccounts`
  （用 internal 的 `data:setConfig` 維護）。工作日換算一律跑
  `.claude/skills/board-tracker/scripts/workdays.mjs`（排除台北的週六日，附
  fixtures 自測），tracker 的做法與紅線在
  `.claude/skills/board-tracker/SKILL.md`。
- 匯入管線：payload 驗證、冪等 upsert、`pruneEpics` 全量同步
- 從 Jira 匯入的流程整理成 skill（`.claude/skills/jira-board-import/`），
  當看板助理的流程整理成另一個 skill（`.claude/skills/board-assistant/`），
  當進度追蹤器的流程整理成第三個（`.claude/skills/board-tracker/`）
- Convex 靜態託管部署（production / dev 兩個 deployment）

## 尚未實作

- 帳號自助管理（改密碼、忘記密碼、撤銷）——現在只能由管理者用 internal 的
  `auth:seedUser` / `auth:deleteUser` 處理
- 回寫 Jira（看板上的修改只留在 Convex，完整重新匯入會被 payload 蓋掉）
- 換卡片的 Epic（刻意不做，見 data-model.md）
- Jira 同步自動化（目前由 Agent 依 skill 手動執行）
- 使用者那邊的推播（助理已經是即時的，但使用者沒有瀏覽器通知；看板沒開著的時候
  指令就停在 `pending`）
- 進度追蹤的排程本身（Routine 要在 Claude 那邊建，repo 裡只有 skill 與腳本），
  以及週報的歷史頁（`reports` 表存了每週一份，但 UI 只給最新那則通知的連結）
