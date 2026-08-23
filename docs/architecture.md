# 專案結構與實作細節

## 專案結構

```
convex/
  schema.ts          資料表與共用 validator
  board.ts           board:get — 依時間區間回傳看板（含 config）的單一 reactive query
                     board:moveTicket / reorderCell / createTicket / updateTicket /
                     deleteTicket — 看板的公開寫入面
                     board:addNextWeek — 在最新週次後面加一列（預排下週）；日期在這裡
                     推導，提議權的人也是直接建立
                     每個 handler 第一行是 requireRead / requireEdit，寫入權直接套用、
                     只有提議權就轉成 editRequests
  apply.ts           所有對 tickets 的真實寫入（直接寫入與核准提議共用同一份）
  editRequests.ts    編輯提議：合併寫入、board:get 的疊加、diff 描述，
                     以及 list / mine / withdraw / approve / dismiss
  messages.ts        看板助理的聊天：使用者那半邊（send / thread / claim / report，
                     要 permRead）與助理那半邊（agentWatch / agentInbox / agentRead /
                     agentReply / agentCommand / agentMarkRead / agentMarkHandled，
                     要 permAgent）。指令只是一則訊息，看板由使用者的瀏覽器去改；
                     agentWatch 是助理 WebSocket 訂閱的「還沒讀到的事件」
  notifications.ts   進度追蹤：使用者那半邊（mine / dismiss，要 permRead）與 tracker 那半邊
                     （trackerSend / trackerBroadcast / trackerPendingRechecks /
                     trackerResolveRecheck / trackerReportUploadUrl /
                     trackerPublishReport，要 permTracker）。tracker 改看板走的是
                     一般的 board:* mutation，所以這裡沒有任何寫看板的程式碼
  auth.ts            登入與權限的唯一關口：requireRead / requireWrite /
                     requireEdit / requirePermission、login / register /
                     pendingUsers / approve / dismiss，以及 internal 的
                     seedUser / deleteUser / listUsers（見 data-model.md）
  validation.ts      匯入與公開 mutation 共用的欄位檢查
  staticHosting.ts   re-export static-hosting component 的 deployment query
  data.ts            importBoard / removeEpics / removeTickets / summary — 維運入口
                     setConfig / getConfig — 看板設定（internal）
  convex.config.ts   掛載 static-hosting component
src/
  App.tsx            登入閘門：四個狀態，其中一個是看板
  BoardApp.tsx       看板本身（DndContext、board:get 訂閱、所有 mutation 呼叫）
  lib/auth.ts        Credentials 型別、Web Crypto 算 tokenHash、localStorage 存取
  lib/board.ts       型別、樣式對應表、checkpoint 與逾期的推導邏輯
  lib/dates.ts       ISO 日期工具（以字串比較避開時區偏移）
  lib/github.ts      PR 網址 → #編號 徽章文字
  lib/jira.ts        ticket key + config 的 base URL → Jira 網址（沒設定就回 null）
  lib/assignee.ts    負責人頭像的縮寫與顏色（config 指定優先，其次姓名 hash）
  lib/scroll.ts      捲到本週那一列（開場自動捲動與按鈕共用）
  lib/filters.ts     篩選選擇的 localStorage 存取（版本化 key、載入時驗證）
  lib/dnd.ts         拖曳的資料型別、暫存區 id、碰撞判定、drop 目標解析
  lib/assistant.ts   助理指令的型別、key／epic code → Convex id 的解析、
                     指令摘要與未讀時間的 localStorage 存取
  hooks/             useStatusCycle — 狀態燈號的點擊循環與 debounce
                     useCommandExecutor — 認領並執行助理下的指令
  components/        AuthProvider — 憑證的 context（訂閱 auth:login）
                     NotificationBell — header 右側的第二個鈴鐺（進度追蹤通知）
                     LoginScreen — 登入／註冊表單與等待審核的畫面
                     AccountBar — header 右側：收件匣鈴鐺（註冊／待審編輯／我的提議）、
                     帳號、唯讀或提議徽章、登出
                     BoardHeader / BoardMatrix / TicketCard / StatusDot
                     MultiSelectFilter — 狀態與負責人共用的多選下拉
                     AssigneeAvatar — 卡片與篩選選單共用的負責人頭像
                     BoardConfigProvider — 看板設定的 context（來自 board:get）
                     DraggableTicket / StagingTray — 拖曳與暫存區
                     TicketDialog — 新增／編輯／刪除卡片的表單
                     BoardActionsProvider — 開表單與切換狀態的 context
                     BoardAssistant — 右下角的聊天泡泡與對話視窗（含執行器）
                     UpdateNotice — 有新版本時的重新載入提示
  components/ui/     shadcn/ui 元件
data/
  example-epic.json  合成的範例 payload（格式參考；真實 payload 不進版控）
docs/                本目錄：資料模型、專案結構、進度
.claude/skills/
  jira-board-import/ 從 Jira 匯入的 skill；匯入／週次／狀態對應腳本在它的 scripts/，
                     payload 格式與更新看板資料的說明在它的 references/
  board-assistant/   當看板助理的 skill：憑證從環境變數來、main agent／sub-agent
                     的分工、指令格式、結果狀態機與紅線；
                     scripts/agent-call.mjs 是一次 HTTP 呼叫，
                     scripts/listen.mjs 是「阻塞到有事發生就結束」的 WebSocket listener
  board-tracker/     當進度追蹤器的 skill：四個排程職責、卡住的定義、週報章節與紅線；
                     scripts/tracker-call.mjs 是一次 HTTP 呼叫，
                     scripts/workdays.mjs 算工作日（排除週末，含自我測試），
                     scripts/upload-report.mjs 上傳週報並廣播
```

`convex/_generated/` 有進版控，所以剛 clone 下來不需要先登入 Convex 就能 `npm run build`。

## 登入閘門與唯讀看板

權限的語意、`users` 表與帳號怎麼開，都在 `docs/data-model.md` 的「登入與權限」。這裡只講前端怎麼組起來。

`App.tsx` 現在只有一件事：`AuthProvider` 包著一個四路的 switch。`AuthProvider` 從 localStorage 讀一次憑證，然後**訂閱** `auth:login`（不是呼叫一次就算了）——帳號被刪、密碼被換、`permWrite` 被打開，都會在不重新載入的情況下反映到畫面上。看板（`BoardApp.tsx`）**只在 `authenticated` 掛載**：`board:get` 對壞憑證是丟錯的，而丟錯的 query 會把整頁帶走；讓憑證失效的那一次 render 直接把看板卸載，錯誤就沒有機會浮出來，使用者看到的是登入頁加一行「登入資訊已失效」。四個狀態裡 `loading` 也是刻意的——省掉它會讓已登入的人每次開頁都先閃一下登入表單。

登入頁與等候室由 `FrontDoor` 包住，裡面放 `UpdateNotice`：`staticHosting:getCurrentDeployment` 是唯一不收憑證的 query，正是為了讓停在登入頁的分頁也能知道有新版本。

既沒有 `permWrite` 也沒有 `permEditRequest` 的人拿到唯讀看板。`canEdit` 搭現成的 `BoardActions` context 走，不另外拉一條 prop：格子的「+」不繪製，卡片不再 `cursor-pointer` 也不開表單，狀態燈號從 `<button>` 換成 `<span>`（帶 `aria-label`，讀者還是知道那是什麼顏色），`useSortable({ disabled })` 讓卡片拖不動。**這只是不給誤導性的 affordance**——真正的防線是後端每個 handler 的 `requireWrite` / `requireEdit`。

`permEditRequest` 的人走的是**同一個** `canEdit`，所以拖曳、modal、燈號一個不少；差別只有 `requestMode` 控制的文案（「提議修改」而不是「儲存」）與卡片上的「待審…」badge。前端沒有第二條呼叫路徑，樂觀更新也不用分岔——mutation 是同一個，要不要當提議由後端決定。

鈴鐺（其實有兩個，右邊那個是收件匣、左邊那個是進度追蹤通知，見「進度追蹤」）在 `AccountBar`（header 右上，和帳號、徽章、登出按鈕同一排）。收件匣，最多三段，**每一段只在對應權限存在時才訂閱**（訂閱一個會拒絕自己的 query 會讓錯誤穿過 header）：`permApproveRegister` → 待審註冊（`auth:pendingUsers`）、`permWrite` → 待審編輯（`editRequests:list`）、`permEditRequest` → 我的提議（`editRequests:mine`）。紅點的條件是「有人在等你」——待審註冊或待審編輯，自己提出的不算。兩個審核權限彼此獨立，所以只有寫入權的人看到編輯那一段、只有註冊審核權的人看到註冊那一段。

註冊那段的「通過」只給 `permRead`，這件事寫在選單的註腳上，因為那是最容易誤會的地方。編輯那段每一列直接把 diff 攤開（誰、哪張卡、什麼 → 什麼），因為審核者要決定的就是那幾行，不該再去看板上找。

## 編輯提議：疊加、合併與核准

語意與 `editRequests` 表在 `docs/data-model.md`；這裡是實作上三件值得知道的事。

**三個模組是為了避免 import 循環。** 真實寫入抽到 `convex/apply.ts`，`board.ts` 與 `editRequests.ts` 都只往它單向 import（`board.ts → {apply, editRequests}`、`editRequests.ts → apply`）。好處不只是循環：核准和直接寫入是同一段程式，不會有「核准後結果不一樣」這種 bug。

**疊加在 `board:get` 裡做，不在前端。** 拿到卡片之後，把呼叫者自己的提議套上去（`overlayTickets`）：`create` 生出一張合成卡片（`_id` 是提議的 id），`delete` 把卡片拿掉，`update` 改欄位，`checkpointId` 變了就整張搬到另一列。搬過去與新增的卡片要**落在該格最後**，做法跟 `appendToCell` 一致：先給 `Number.MAX_SAFE_INTEGER`，再用 UI 那個比較器把受影響的格子重編號 0..n-1，最後才讓明確的 `reorder` 提議覆蓋。這樣 reload 不會掉，別人也完全看不到。

**合併發生在寫入提議的時候，不是讀的時候。** 新的操作先找「我對這張卡的既有提議」，有就併進去（規則表在 data-model.md）。因為 `create` 提議的卡片用提議 id 當 `_id`，接著對它做的修改與刪除自然落在同一列上，前端不需要知道這張卡是真的還是提議的。

## 看板助理：聊天、指令與執行器

`messages` 表、指令白名單與函式面在 `docs/data-model.md` 的「看板助理的對話」。這裡是前端怎麼組起來，以及為什麼要這樣組。

**整個設計就一句話：助理不寫看板，瀏覽器才寫。** 助理（另一個 session 裡的 Claude Code）只能讀寫訊息與 `board:get`，它下的指令是一則訊息；真正呼叫 `board:*` 的是使用者的瀏覽器，用使用者自己的憑證。所以權限語意是免費的——`permWrite` 的人指令直接生效，`permEditRequest` 的人得到一筆待審提議（`requestMode` 只影響回報的字），唯讀的人被 mutation 拒絕，這三條路在前端都沒有專屬程式碼。

**執行器掛在 FAB 上，不掛在視窗裡。** `BoardAssistant` 一直掛載（登入後才有），`useCommandExecutor` 就在它裡面，所以**把聊天視窗關掉不會讓指令卡住**——只要看板那一頁還開著，指令就會被執行；紅點會告訴你有結果可以看。真正會讓指令停在 `pending` 的只有「沒人開著看板」，而那時本來就沒有人能授權這個修改。

**key 的解析在前端，因為看板在這裡。** `resolveCommand`（`src/lib/assistant.ts`）把 key 與 epic code 對成 Convex id。它訂閱的是**不帶 `fromDate` 的 `board:get`**（整段歷史），因為助理提到的卡片可能在沒人捲到的舊週次；而且只在「有 pending 指令」時訂閱（其餘時候 `"skip"`），閒著的聊天不會多養一個 subscription。解析不到就不是壞掉的呼叫，而是一句人看得懂的原因（「看板上找不到 key 為 X 的卡片」）寫回訊息，讓助理自己修。

**認領先於執行。** `messages:claim` 在自己的交易裡把一則 `pending` 翻成 `running` 並回答「是不是你的」，所以開兩個分頁只會執行一次（實測過：兩個分頁、一條 `createTicket`，只長出一張卡）。認領超過 60 秒沒回報就可以被接手——分頁中途關掉不該讓一則指令永遠卡住。指令**一次跑一則、最舊的先跑**，因為同一輪的一批指令常常互相依賴（先開卡、再排那一格的順序）。

**未讀紅點是時間比較，不是計數器。** 視窗關著時最後一則助理訊息比「上次看到」新就亮點，`kanban.chat.seen.v1` 依帳號記在 localStorage（`src/lib/assistant.ts`）。指令訊息在視窗裡顯示助理寫的那句人話、底下一行小字的指令摘要，以及狀態徽章（等待執行／執行中／已執行／已建立提議／失敗），失敗時多一塊寫著原因的紅框——那句原因就是助理接下來要讀的東西。

**「已讀」是後端的 `readAt`，不是前端猜的。** 使用者自己的泡泡底下那一行小字只在 `message.readAt` 存在時出現；寫它的是助理的 listener（收到事件的同一瞬間呼叫 `messages:agentMarkRead`），而 `messages:thread` 是 subscription，所以訊息送出時沒有標示、助理讀到的那一刻反應式地長出來。這是使用者唯一看得出「助理真的在值班」的訊號，所以刻意做得低調（`text-[10px]` 的灰字，靠右）但即時。語意（read ≠ handled）在 data-model.md。

**訊息內容是 markdown。** 泡泡（使用者、助理、指令那句人話）都經 `ChatMarkdown`（react-markdown ＋ remark-gfm）渲染，表格、清單、連結、行內 code 都能用，樣式縮在聊天的 `text-xs` 尺度、依泡泡底色分兩套。渲染器用 `lazy()` 拆成獨立 chunk，只有對話真的畫在螢幕上才下載，Suspense fallback 是原始文字——看板首屏不為它付一位元組。

**FAB 與視窗都在 `z-40`**，刻意低於暫存區與 dialog（`z-50`）：拖曳到一半時聊天泡泡不該蓋住暫存區。`BoardAssistant` 也掛在 `DndContext` 外面——它跟拖曳無關，而且卡片還在空中時執行器得繼續跑。

助理端是**公開函式**（要 `permAgent`），因為它跑在沒有 Convex 憑證的容器裡：跟瀏覽器一樣送 `{ account, tokenHash }`，一次性呼叫走 `POST /api/query`、`/api/mutation`。指令範例與紅線在 `.claude/skills/board-assistant/SKILL.md`；**憑證只從環境變數來，不進版控**。

**助理不輪詢，它被推。** 等訊息的那一半是 `scripts/listen.mjs`：用 `convex` 套件的 `ConvexClient`（Node 22 有內建的 `WebSocket`，不需要額外依賴）訂閱 `messages:agentWatch`，阻塞到有事件為止，然後標已讀、把事件印成 JSON、**結束程序**。「程序結束」就是通知——main agent 把它丟到背景 task，訊息一到就被喚醒（本地實測 ~50ms），不用 `sleep` 迴圈。事件有兩種（`userMessage`、`commandResult`），所以「等使用者下一句」與「等指令跑完」是同一個機制；`--account` 把 feed 縮到一條對話，`--exclude` 把已經派給 sub-agent 的對話讓出去。多個 listener 同時等也不會撞：`agentMarkRead` 回傳它**真正標到**的 id，沒標到的那個就繼續等（認領語意是 mutation 交易免費給的）。

**值班的形狀：待命的人、讓出去的對話、看著讓出去的那雙眼睛。** main agent 只做三件事，細節在 skill 的「The duty loop」：

- **開工前置**：`node_modules` 在不在（listener 要 import `convex`）、三個環境變數有沒有、`auth:login` 打不打得通。listener 跑不起來的助理跟不在值班的助理，從使用者那邊看起來一模一樣。
- **預熱兩個 standby sub-agent**：sub-agent 的第一分鐘花在讀 skill 與確認環境，剛問完問題的人不該付這個錢。所以先派兩個待命者，有對話進來就用 `SendMessage` 交給待命者（Claude Code 的 sub-agent 回報完仍然在、context 還在），同一輪立刻補一個新的 standby。
- **交出去 = 排除 + 監看**：一條對話派給 sub-agent 之後，主 listener 重啟時把該帳號放進 `--exclude`（否則兩個 listener 搶同一句話，而輸的那個可能正是握著對話的 sub-agent），同時把同一份名單餵給 `--escalate`。sub-agent 回報結束才從兩邊移除。**排除而不監看就是放生**，這是下一段存在的理由。

**Escalation：被排除的對話還是有人看著。** `listen.mjs --escalate <帳號…> --grace 5` 是同一個腳本的第二個模式：訂閱一樣的 `messages:agentWatch`，但**不標已讀、不認領**——它看的每一列都是別人的。看到那些帳號的新 `userMessage` 就起一個 grace（預設 5 秒）計時器，到期用 `messages:agentRead` 重讀那條對話：有 `readAt`（或已 `handled`）就表示 sub-agent 還活著，繼續等下一則；還是沒讀就印出一個 `type: "escalation"` 事件並結束程序，main agent 被喚醒後重派（事件沒被認領，所以接手的人看得到全部內容）。因為判定只讀 `readAt`，**後端一行都不用改**；grace 刻意設得很短——誤報只花一次查詢，漏報是一個人對著沒反應的聊天窗坐著。

分工的另一半在 sub-agent 身上：接手一條對話之後**它自己**用 `listen.mjs --account <帳號>` 監看後續訊息（main agent 已經把這個帳號排除了，沒有人會替它接），對話告一段落才 `agentMarkHandled` 並回報。

## 進度追蹤：通知那個鈴鐺，與一個什麼都不寫的 agent

`notifications` / `reports` 兩張表、`permTracker` 與 dismiss→複查的語意在
`docs/data-model.md` 的「進度追蹤與通知」。這裡是實作上四件值得知道的事。

**後端沒有為 tracker 加任何寫看板的路。** tracker 帳號沒有 `permWrite`，所以它呼叫
`board:updateTicket` 的結果就是一筆待審提議——`convex/board.ts`、`apply.ts`、
`editRequests.ts` 一行都沒改（實測：tracker 送一次 `updateTicket`，看板沒變、有寫入權
的人的鈴鐺多一列 diff）。`convex/notifications.ts` 只有通知與週報，**不 import
`apply.ts`**，也不 query `tickets`。要改 tracker 能做什麼，改的是它的權限與 skill，
不是看板的寫入面。

**第二個鈴鐺跟第一個是同一套視覺。** `NotificationBell` 和 `InboxBell` 是兄弟：同樣的
trigger 樣式、同樣的紅點（`size-2` 的 rose 圓點加白色 ring）、同樣的 `w-96` dropdown
面板。差別只有兩個——**它給每個人看**（`permRead` 就有，所以沒有「訂閱一個會拒絕自己的
query」的問題，不需要條件式 `"skip"`），而紅點的條件單純是「清單不是空的」（通知本來
就是給你的，沒有「別人在等你」這一層）。每一列是 `kind` 徽章 ＋ 時間 ＋ 純文字
（`whitespace-pre-wrap`，tracker 寫的是幾行短句）＋ key 徽章 ＋ 一個「開啟」連結
（`target="_blank"`）。**沒有任何延遲載入的必要**：沒有新依賴、沒有 markdown 渲染器，
bundle 幾乎不動。

**「進度」那一列的 × 說得出它會做什麼。** `title` / `aria-label` 是「知道了，請
tracker 複查」，面板底下還有一行註腳。因為那個按鈕不是「隱藏」——它會讓 tracker 再查
一次，而使用者有權知道自己按下去等於做了一個宣稱（語意在 data-model.md）。

**排程在 Routine，不在程式裡。** 四個 Routine（兩次巡邏、週一週報、每小時複查掃描）各
自開一個**新 session**，prompt 只說「哪個職責 ＋ 哪個 deployment ＋ 先讀
`.claude/skills/board-tracker/SKILL.md`」，憑證從執行環境的環境變數來。所以這個 repo
裡沒有 cron 設定檔也沒有排程程式碼——時間表與 UTC 換算寫在 skill 的「Scheduling」。
工作日換算一律走 `scripts/workdays.mjs`（週末以 Asia/Taipei 判斷，UTC+8 沒有 DST 所以
是常數位移；`node workdays.mjs test` 有 10 個固定 fixture，含跨週末與門檻邊界），
週次換算一律走 `npm run week`。

## 時間區間與 lazy loading

`board.get` 收一個 `fromDate`（ISO 日期），只回傳**結束日在該日之後**的週次列與這些列的卡片，並附上 `hasOlder` 告訴前端還有沒有更早的資料。卡片是逐 checkpoint 走索引取，不是整張表掃出來再過濾，所以成本跟著視窗大小而不是資料總量。

前端首次只載入近 8 週，每次再往前拉 8 週，`hasOlder` 變 false 就停止請求並收起入口。四個實作細節：

- **開場捲到本週**：先載入的 8 週大多是歷史，停在最上面等於先給讀者最舊的一列。所以第一次拿到資料後會把本週那一列捲到欄位標題正下方（標題是 sticky，要扣掉它的高度否則會被蓋住）。只做一次，之後捲動位置就完全屬於讀者——要回到本週，用左上角落格的按鈕。按鈕和開場捲動共用 `scrollToCurrentWeek()`（`src/lib/scroll.ts`），所以兩者停在完全相同的位置；資料裡沒有本週時它回傳 false，按鈕也就直接 disabled。
- **入口是按鈕，不只是捲動手勢**：看板初次繪製時 `scrollTop` 已經是 0，此時往上滑不會觸發 `scroll` 事件，單靠捲動偵測會讓讀者完全載不到更早的週次。所以頂端那一列是可點的按鈕，捲動偵測只是額外的便利路徑。
- **維持捲動位置**：往上補列會讓 `scrollHeight` 變大，若不處理，讀者會被推到頁面下方。所以在請求前記下「距底距離」，DOM 更新後用 `useLayoutEffect` 還原，原本在看的那幾列就留在原處。
- **不閃白**：Convex 的 `useQuery` 在參數改變時會先回 `undefined`。直接用會讓整個看板在載入更早週次時消失一瞬間，所以保留上一次的結果繼續畫，只在頂端顯示載入中。

## 預排下週：把週次軸往後長

Lazy loading 讓週次軸往**過去**長，`addNextWeek` 讓它往**未來**長。匯入的 payload 只帶已經有工單的週次，所以最新一列通常就是當週，沒有格子可以放下週的工作。

最後一個**週次**列下面有一條低調的整寬列：`＋ 預排 W34（08/23 - 08/29）`。四個實作細節：

- **位置是「最後一個週次列」，不是「最後一列」。** 沒有日期的 backlog 列永遠排在週次之後，而「backlog 的下一週」沒有意義，所以 `BoardMatrix` 找的是最後一個 `kind === "week"` 的列，把 affordance 插在它和 backlog 之間。
- **標籤是推導的，不是寫死的。** `nextWeekPreview()`（`src/lib/board.ts`）拿看板最新週次的日期各 +7 天、號碼 +1，只為了讓按鈕說得出**要加哪一週**。呼叫時**只送這個號碼、不送日期**——列上的日期是 `board:addNextWeek` 自己推的（見 data-model.md）。送號碼正是幂等的來源：連點兩下、兩個分頁同時按，都只會長出一列。按鈕在 round trip 期間也是 disabled 的。
- **新列反應式出現，affordance 跟著往下移。** `board:get` 是同一個訂閱，所以新列自己畫出來，affordance 重新算之後落在新的最後一列下面——同一個手勢因此天然可以再往後排一週。這裡**沒有樂觀更新**：加一列時沒有任何手勢正在進行，等一趟 round trip 不痛，而只有伺服器知道要寫哪些日期。
- **唯讀帳號看不到它**（`canEdit`），跟其他編輯 affordance 一致。只有提議權的帳號**看得到而且真的能按**——建列是直接生效的，不變成提議（理由見 data-model.md）；把卡片拖進新列則照舊變成一筆提議。

新列對其他功能是透明的：拖曳的 drop 目標、編輯 modal 的週次下拉、暫存區流程都是從 `board:get` 的 `checkpoints` 長出來的，所以不需要為它多加程式碼。「回到本週」也不受影響——**本週是含今天的那一列，不是最新的那一列**（`describeCheckpoints` 用今天的日期判斷 phase），所以預排了幾週之後按下去還是停在當週。

## 版面

Header 固定 105px，分兩層：標題列與工具列（搜尋、狀態多選、負責人、重置）。

Y 軸的週欄位是 48px 寬的窄邊欄，標籤以 `writing-mode: vertical-rl` 轉 90 度顯示，讓週次資訊只佔垂直空間、把水平空間全部留給卡片。中文標籤必須同時設 `text-orientation: sideways`，否則預設會維持直立字形，再套 `rotate-180` 就會上下顛倒。

工具列有三個多選篩選，共用 `MultiSelectFilter`：**Epic**、**狀態**與**負責人**。三者都是不勾選代表不過濾（顯示全部），勾選則取聯集，彼此再取交集。狀態選單每一項都是「燈號 + 完整狀態名稱」，所以它同時是四個燈號的圖例。

Epic 篩選和另外兩個不太一樣：**epic 是欄，所以篩選是把整欄拿掉**（連欄位標題一起），矩陣的寬度是從欄數算出來的，會自己縮成剩下的欄。選項文字是 `CODE · 名稱`，因為 code 才是 payload 與 Jira key 講的語言。被藏起來的欄裡的卡片也不算在右側的「已顯示 / 總數」裡。

拖曳在篩選中的視圖照常運作（被藏起來的欄沒有格子，也就不可能成為 drop 目標）。一個邊角情況：卡片停在暫存區時把它的 epic 篩掉，那張 chip 會留在暫存區但沒有合法的落點——用 chip 上的「放回原本的格子」把它放回去就好。

Epic 與負責人的選項都是從當下看板資料推導的，不是寫死的名單——選單裡不會出現沒有票的人，也不會出現看板上沒有的 epic。沒有負責人的票由「未指派」這個選項涵蓋（內部以 `null` 表示，不是佔位字串）。右側的計數在有篩選時顯示 `已顯示 / 總數`。

## 篩選會記住，搜尋不會

三個篩選的選擇存在 `localStorage` 的 `kanban.filters.v1`（`src/lib/filters.ts`）：改變時寫入，開頁時讀一次。只盯著一個 epic 工作的人每天早上不必重新勾三個選單。

**搜尋字串刻意不存。** 打在搜尋框裡的是「現在要找哪張卡」的問題，不是看板的觀看方式；隔天打開卻只剩兩張卡、而原因藏在一個沒人會注意的輸入框裡，是很糟的體驗。篩選會在工具列上表明自己的存在，過期的搜尋不會。

存的是 **epic `code` 與負責人姓名**，不是 Convex id——重新匯入讓 epic 換了一份文件，篩選依然對得上。載入後會拿當下的看板資料驗證一次：看板上已經沒有的 epic 或人會被安靜地丟掉（連帶從 storage 移除），不會變成「什麼都篩不出來」的幽靈條件。存成「什麼都沒勾」就會還原成「什麼都沒勾」，也就是顯示全部。讀不到、壞掉、版本不對的內容一律當作沒有篩選——壞掉的偏好不該讓看板打不開。

## 負責人顏色與 Jira 連結

負責人以圓形頭像呈現：白色縮寫字疊在一個屬於這個人的顏色上（`AssigneeAvatar`）。顏色照這個順序決定（`src/lib/assignee.ts`）：

1. **`config.assigneeColors` 指定的顏色**——團隊現有成員都在這裡，一人一色、手動指定、不會變。
2. **姓名 hash 進 10 色調色盤**——名單裡沒有的人（例如剛加入、還沒有人去設定）也會拿到一個穩定的顏色：同一個姓名（去空白、轉小寫）在任何 deployment、任何 session 都 hash 到同一個顏色，不受載入順序影響。

兩層都不依賴渲染順序，所以掃一整欄找「這是誰的卡」才有意義。調色盤每個顏色都通過白字 4.5:1 的對比檢查；未指派用中性的 slate。fallback 的顏色有機會和某個指定顏色相同（10 色的必然結果）——真的在意就把那個人加進 config。

顏色是行內 style 而不是 Tailwind class：兩層的值都是執行期才知道，Tailwind 掃不到就不會產生對應的 CSS。

卡片的 key 連到 `config.jiraBaseUrl` + key（`jiraIssueUrl()` 容忍結尾多餘的斜線）。**沒有設定 base URL 時 key 就是純文字**，不做成會 404 的連結。連結會 `stopPropagation` pointerdown，所以點連結不會變成拖曳的開始。

## 拖曳改週次與暫存區

拖曳用 `@dnd-kit/core`：`DndContext` 在 `BoardApp`，卡片是 `DraggableTicket`，每個 (checkpoint, epic) 格子是 droppable。四個要點：

- **只能上下移動，不能左右換欄。** 格子在 hover 時自己比對「拖曳中的卡片是哪個 epic」：同欄標靛藍並顯示「放這裡」，別的 epic 標紅顯示「不能跨 Epic」且放下無效。同一條規則在 `board:moveTicket` 再驗一次，前端的視覺提示不是唯一的防線。
- **暫存區。** 拖曳一開始，畫面底部中央會出現暫存區；把卡片丟進去就先從矩陣裡「拿起來」（純前端狀態，沒有任何寫入），捲到目標週次後再從暫存區拖出去放。暫存區在還有卡片或還在拖曳時保持顯示。空的時候它只有一行提示字，那是很難命中的目標，所以空狀態給了固定尺寸——量到的 289×45 的兩倍（578×90）；裝了卡片之後就照內容長大。它浮在矩陣上方，所以碰撞判定用 `trayFirstCollision`：指標落在暫存區內時，優先給暫存區，不然 `pointerWithin` 有機會把 drop 判給底下被遮住的格子。
- **暫存區的卡片還沒有移動。** 只有放進格子才會呼叫 mutation；關掉分頁等於什麼都沒發生。每張暫存卡片記著自己的 epic，所以繞這一圈之後同欄限制照樣成立。
- **樂觀更新。** 兩個 drop mutation（`moveTicket`、`reorderCell`）都在送出前先改本地 store：dnd-kit 在放手那一刻就把 transform 清掉，如果畫面還在用伺服器的舊答案，卡片會先跳回原位再彈到新位置（實測過，去掉 `reorderCell` 的樂觀更新就會重現：放手後有好幾個 frame 還是舊順序）。`moveTicket` 的樂觀更新也順手把 `order` 設成目標格的最後一個，否則那張卡會有一瞬間排在格子中間。失敗時 Convex 自己回滾，前端在底部顯示紅色訊息。暫存卡片是從整個時間窗（不是篩選後的清單）推導出來的，所以改篩選不會讓暫存的卡片憑空消失。

篩選開著時拖曳操作的是「看得到的卡片」——被篩掉的卡片不在畫面上，也就不會被拖到。

## 同一格內排序

格子裡的卡片用 `@dnd-kit/sortable`：每一格是一個 `SortableContext`（id 就是格子 id），卡片是 `useSortable`。拖曳時其他卡片讓開的動作是 sorting strategy 算出來的 transform，**沒有任何 state 改變、也沒有任何寫入**；放手才呼叫 `reorderCell` 寫一次。要送的順序不是自己另外算的，而是直接取 dnd-kit 自己的 `sortable.items` 與 active/over 索引跑 `arrayMove`——畫面上看到的位移和存進資料庫的順序因此同源。

放在哪一格是用「drop 目標」判斷的：指標放開時可能落在格子上，也可能落在另一張卡片上，而兩者都代表同一件事（卡片自己帶著 `checkpointId`），所以 `resolveDropTarget()` 兩種形狀一起讀，並用 `onCard` 記下「這次是落在卡片上」。同格 → 排序；不同格 → `moveTicket`。

### 一個位置只有一個提示

卡片和格子是重疊的 droppable（卡片就在會接受 drop 的格子裡），所以直接用 `pointerWithin` 會同時命中兩者，而 dnd-kit 取第一名——那個排序會因為一兩個 pixel 的移動而翻面，也會在排序預覽把卡片挪到指標底下時再翻一次。結果就是 `over` 在「卡片」和「格子」之間跳，排序預覽跟著卡片、`放這裡` 跟著格子，兩個提示互相閃。同一個根因還有兩個症狀：指標落在兩張卡片之間的空隙時沒有任何卡片命中，而移到別的 Epic 的格子上時常常是那一格的卡片贏，所以紅色的拒絕提示根本不會出現。

修法是 `boardCollision`：**一個位置只解析出一個目標**，順序固定——

1. 指標在**暫存區**裡就是暫存區（它浮在矩陣上方，否則會和底下的格子競爭）。
2. 指標在**來源格**的範圍內，就一定解析成那一格的某張卡片，用 `closestCenter` 在該格卡片之間挑最近的——所以停在卡片之間的空隙也還是卡片，預覽不會斷。dnd-kit 的 droppable 量測是在拖曳開始時做的，排序預覽的位移不會改變這個排名，同一個位置永遠得到同一個答案。
3. **其他任何地方就是格子**；來源格以外的卡片完全被排除在候選之外，因為 dnd-kit 只能在「正在拖的那個列表」裡預覽位移，在別格給出卡片目標等於承諾一個放手後做不到的排序。

三個提示因此互斥：來源格內只有卡片在讓開（格子不出聲），同 Epic 的其他格只有靛藍的 `放這裡`，別的 Epic 只有紅色拒絕。所有提示都從 `resolveDropTarget()` 這一個值推導，`DropCell` 不再各自看 `isOver`——兩個元件各自解讀 `over`，就是它們會吵架的原因。

### 拖曳時的自動捲動要短

還有一個和碰撞判定無關、但看起來一樣的閃動來源：dnd-kit 預設把捲動容器**外圍 20%** 當成「請捲動我」，而看板的 sticky 欄位標題就落在那個帶子裡。於是從靠上方的地方抓起一張卡，矩陣就會在指標沒動的情況下自己往上爬（實測 `scrollTop` 474 → 352），一格一格從指標底下滑過去，提示自然跟著換。所以 `autoScroll` 收成上下各 8% 的窄帶、降低加速度，**水平方向直接關掉**：卡片只能留在自己的 Epic 欄，橫向捲動只會把讀者帶離所有合法目標。長距離的搬運交給暫存區。

**跨格拖曳一律落在目標格的最後**，不是放開的那個位置。dnd-kit 只會在「正在拖的那個列表」裡預覽位移，跨格時畫面上不會讓開，硬要寫入放開的位置會變成「先看到接在最後、放手後又跳到別的地方」。要精準插入就先放到那一格，再在格子裡拖一次。

## 新增／編輯／刪除卡片

每個格子右上角有一個 hover 才出現的「+」，點了開 `TicketDialog`，Epic 與週次已經帶好（沒有全域的新增按鈕：卡片一定屬於某一格，從那一格開始填最短）。點卡片本身則是開同一個表單的編輯模式。

拖曳與點擊共存靠兩層：PointerSensor 要 6px 位移才算拖曳，所以單純的點擊還是點擊；而拖曳結束時瀏覽器仍會補一個 click，所以 `openEdit` 會忽略「放手後 250ms 內」的點擊。卡片上的 Jira 連結、PR 徽章與狀態燈號各自 `stopPropagation`，不會順便打開表單。

表單裡 **Epic 與 Key 是唯讀的**（原因見 data-model.md），刪除按鈕需要按第二次確認。錯誤直接顯示在表單裡——mutation 的驗證訊息是給人看的，不該只留在 console。

## 狀態燈號：點一下換狀態

燈號是個按鈕，點一下往前一格（todo → doing → testing → done → todo）。寫入用 debounce 而不是每次點都送：連點四下把卡片繞回原狀不應該是四趟 round trip，中間那些值也不是誰想記錄的狀態。所以每次點擊先更新本地的 override（燈號畫的是它），並重設 1 秒的計時器，**停手之後才寫一次最終值**（`src/hooks/useStatusCycle.ts`）。override 撐到 mutation 回來才收，燈號不會在寫入途中閃回舊色。

override 在資料進入篩選之前就套上去，所以卡片、暫存區的 chip、拖曳中的預覽三個地方講的都是同一個狀態。

計時器還沒到就離開頁面的情況，實測過：WebSocket 在導覽時就被拆掉，普通的 mutation 送不出去（點一下馬上重新載入 → 沒寫進去）。所以 `pagehide` / `visibilitychange` 的 flush 改走 Convex 的 HTTP mutation 端點並加上 `keepalive: true`——這是 `navigator.sendBeacon` 那一級的保證，瀏覽器有義務把請求送完。這條路徑自己組 request body，所以憑證也要自己帶：hook 收一個 `auth` 並用 ref 保存最新值，body 裡的 `args` 是 `{ auth, ticketId, status }`，跟正常的 mutation 一樣會過 `requireWrite`。剩下的風險很小而且刻意接受：keepalive 請求失敗就丟掉那一下點擊，卡片維持原狀態，等於沒點。

## 有新版本時的提示

看板是那種「開著一整週不關」的頁面，所以部署了新版本要講出來，否則使用者會一直看著週一載入的那份 bundle。

static-hosting component 自己記著「現在服務的是哪一次部署」，`convex/staticHosting.ts` 把它的 query re-export 成 `staticHosting:getCurrentDeployment`（**唯讀，而且是唯一不收憑證的公開函式**——它只講部署資訊，且登入頁也要能提示更新）。前端的 `UpdateNotice` 用 component 提供的 `useDeploymentUpdates()` 訂閱它：hook 記住首次繪製時看到的 deployment id，只有在 id 改變時才回報有更新——所以正常開頁面不會跳提示，只有在你開著頁面時有人部署才會。提示可以按「重新載入」或關掉（關掉只針對這一次部署）。

提示條是自己做的，不是 component 內建的 `UpdateBanner`：內建那個帶自己的 inline style 與英文文案。自製的版本長得像看板的其他元件，而且定位在 `<main>` 上（`absolute`），所以不需要知道 header 有多高，也不會和底部的拖曳暫存區疊在一起。
