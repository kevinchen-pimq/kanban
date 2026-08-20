# Agent guide

Epic × Checkpoint 看板：Epic 為欄、週 checkpoint 為列的矩陣看板。前端 React +
TypeScript + Vite + Tailwind v4 + shadcn/ui，後端與靜態託管都在 Convex。
資料由匯入腳本寫入，不回寫 Jira；看板本身也能編輯（拖曳換週次／排序、新增、
修改、刪除、點燈號換狀態，都走 `board:*` mutation），但 payload 仍是事實來源
——重新匯入會蓋回 payload 的值。看板前面有帳號密碼登入：讀要 `permRead`、
寫要 `permWrite`，只有 `permEditRequest` 的人做的每個編輯會變成一筆待審提議，
註冊要有人審核（見下方慣例與 `docs/data-model.md`）。看板右下角還有一個聊天助理：
使用者跟一個 agent 對話，agent 只讀寫訊息（要 `permAgent`），要改看板時下指令，
由**使用者的瀏覽器**用**使用者自己的憑證**執行；agent 靠 WebSocket 即時被喚醒，
讀到訊息會即時回寫「已讀」。

## 常用指令

```bash
npm run dev          # Vite (5173) + convex dev 並行
npm run typecheck    # tsc -b（改完 TS 先跑這個）
npm run build        # 型別檢查 + 建置
npm run import -- <payload>.json [--prod|--dry-run]   # 匯入看板資料
npm run week -- <date> | --windows <a> <b> | --checkpoints <lo> <hi>
npm run board        # dev 看板摘要
npm run deploy       # 建置 + 推 production + 上傳靜態檔
```

## Convex 認證（每個 remote session 都要做一次）

Remote 容器每次都是全新的，沒有 Convex 憑證；要讀寫團隊 deployment（匯入、
`npm run board`、部署）前先完成登入。登入走 device flow——不能開瀏覽器沒關係，
把連結交給使用者開啟驗證即可：

```bash
npx convex login --no-open --device-name "claude-code-remote-kanban"
#   （非互動終端必須給 --device-name，否則會卡在輸入提示）
# → 背景執行它，從輸出取得 https://auth.convex.dev/device?user_code=XXXX-XXXX
# → 把連結貼給使用者，請他們在瀏覽器完成驗證（約 5 分鐘內有效）
# → 成功後憑證寫入 /root/.convex/config.json

npx convex deployment select laudable-buffalo-595   # 指回團隊 dev deployment
```

之後 `npm run import` / `npm run board` 直接可用，production 操作加 `--prod`。
注意：

- 登入後若被問「要不要 link 既有的 anonymous deployment」，忽略它——那是本地
  測試用的拋棄式 deployment。
- 憑證跟著容器走，session 結束就消失，下個 session 重來一次。
- 每次登入都會在 Convex 帳號上留下一個 access token（以 `--device-name` 命名）。
  發出的憑證可以在 https://dashboard.convex.dev/profile#personal-access-tokens
  管理，**session 結束後記得去清理**，並提醒使用者這件事。
- 只想在本地驗證、不碰團隊資料時，用 `CONVEX_AGENT_MODE=anonymous npx convex dev`
  起匿名本地 deployment 即可，不需要登入。

## 文件地圖

| 要做的事 | 先讀 |
| --- | --- |
| 了解專案、啟動開發 | `README.md` |
| 更新看板資料、payload 格式 | `.claude/skills/jira-board-import/references/updating-board-data.md` |
| 動 schema 或狀態燈號 | `docs/data-model.md` |
| 改前端（lazy loading、版面）或找檔案 | `docs/architecture.md` |
| 開帳號、給／收權限、看登入怎麼運作 | `docs/data-model.md` 的「登入與權限」 |
| 動編輯提議（提議、合併、疊加、審核） | `docs/data-model.md` 的「編輯提議」＋ `docs/architecture.md` 同名章節 |
| 確認做到哪、還缺什麼 | `docs/progress.md` |
| 把 Jira epic 上板、改匯入流程 | `.claude/skills/jira-board-import/SKILL.md`（用 skill，別自己重推流程） |
| 當看板助理、回聊天訊息、用指令改看板 | `.claude/skills/board-assistant/SKILL.md`（用 skill；憑證從環境變數來、等訊息用 `scripts/listen.mjs`） |
| 動聊天／指令／已讀機制（`messages` 表、執行器、listener） | `docs/data-model.md` 的「看板助理的對話」＋ `docs/architecture.md` 的「看板助理」 |

## Coding 原則

- **保持簡單，帶著 YAGNI 的精神**——除非另有指示，不要為想像中的需求先鋪路。
- **善用型別安全。** TypeScript 的型別是工具，不是負擔。
- **不要怕提大膽的想法**——只要它能實質改善這份工作，就值得提出來。
- **測試是好事，但要聚焦。** 無止盡的煙霧測試、為已刪除功能寫的「回歸測試」
  價值低得多；測試要精準，不要灌水。
- **註解用來說明功能與用法。** 不必逐行註解，但在函式、類別定義上方簡潔描述
  它怎麼被使用是好事。
- **註解要跟著程式碼更新。** 改動時同步維護，過期的註解比沒有更糟。

## 不可違背的慣例

- **從 Jira 匯入一律走 `jira-board-import` skill。** Atlassian MCP 與 GitHub
  搜尋有幾個不報錯、只給錯答案的坑，都記在 skill 裡。
- **匯入相關腳本住在 `.claude/skills/jira-board-import/scripts/`**，不在專案根目錄；
  日常操作走 `npm run import` / `npm run week`。
- **真實 payload 不進版控，家在 Google Drive 的 `Kanban` 資料夾**（`data/*.json`
  被 gitignore，`data/example-epic.json` 是唯一的合成範例）。匯入前用 Google
  Drive MCP 從那裡下載，匯入成功後把更新版傳回去。不要把真實工單標題、姓名、
  內部 repo 連結寫進 repo。
- **週次換算一律跑 `npm run week`，不要心算。** `weekNumber` 是團隊編號
  （週日到週六），不是 ISO 週號。
- **未知的 Jira 狀態要加進對應表**（skill 的 `scripts/jira-status.mjs`），
  不要在 payload 裡硬塞 `status` 繞過去；匯入失敗是刻意設計。
- **checkpoint 列順序由日期推導**，`convex/board.ts` 會忽略 payload 的
  `order`——看到「列排錯」先想到這裡，不是 bug。
- **每個公開函式都自己檢查權限，`convex/auth.ts` 是唯一的關口。** 前端把
  `{ account, tokenHash }`（`tokenHash = sha256("kanban:<account>:<password>")`，
  在瀏覽器用 Web Crypto 算）當 `auth` 參數送進每一次呼叫；handler 第一行就是
  `requireRead` / `requireWrite` / `requireEdit` /
  `requirePermission(..., "permApproveRegister" | "permAgent")`。
  讀（`board:get`）要 `permRead`，寫（`board:moveTicket` / `reorderCell` /
  `createTicket` / `updateTicket` / `deleteTicket`）要 `permWrite` 或
  `permEditRequest`，助理那半邊的訊息函式（`messages:agent*`）要 `permAgent`；
  唯一不收憑證的
  是 `staticHosting:getCurrentDeployment`（只有部署資訊，登入頁也要能提示更新）。
  **認證過不等於可信任**，欄位驗證照樣要跟匯入一樣嚴（標題非空、ISO 日期、PR
  網址、key 唯一、epic 護欄），共用的檢查住在 `convex/validation.ts`。
  **匯入、設定與帳號管理一律留在 internal**（`convex/data.ts` 的 `importBoard` /
  `setConfig`，`convex/auth.ts` 的 `seedUser` / `deleteUser` / `listUsers`）；
  `approve` 只會給 `permRead`，`permWrite`、`permEditRequest`、
  `permApproveRegister` 與 `permAgent` 只能從終端機用 `seedUser` 給，UI 沒有這條
  路。要再加公開函式前先想清楚它要哪個權限。
- **`permEditRequest` 的人走同一組 `board:*` mutation，分岔在後端。** 有
  `permWrite` 就直接套用，只有 `permEditRequest` 就轉成 `editRequests` 的一筆提議
  （同一張卡的多次操作合併成一筆）。前端不分岔，樂觀更新也不分岔——要改編輯行為
  就改 `convex/board.ts` 的那個分岔，不要在 UI 裡再開一條路。真實寫入只住在
  `convex/apply.ts`，核准提議跟直接寫入共用它，所以兩邊結果永遠一致。
- **看板助理只碰訊息，永遠不直接寫看板。** 助理帳號拿 `permRead + permAgent`，
  能叫的只有 `messages:agent*` 與 `board:get`；要改看板就用 `agentCommand` 下一條
  指令（卡片一律用 **key** 指涉），由使用者的瀏覽器（`useCommandExecutor`）拿使用者
  的憑證去跑那五個 `board:*` mutation。所以權限語意是免費的，不要為助理開任何寫入
  路徑。助理跑在沒有 `convex login` 的 session，一次性呼叫走 HTTP `/api/query`、
  `/api/mutation`，**等訊息一律用 `scripts/listen.mjs`（WebSocket 訂閱
  `messages:agentWatch`，阻塞到有事件就結束程序），不要寫 `sleep` 輪詢迴圈**；
  main agent 只負責等與派工，一條對話一個 sub-agent。已讀（`readAt`，listener 自動標）
  跟處理完（`handled`）是兩件事，不要合併。
  **憑證只從環境變數來，不准寫進版控檔案**（做法見 `board-assistant` skill）。
- **卡片不能換 Epic，也不能改 key。** 拖曳、編輯 modal 與 mutation 三處都擋掉；
  要換欄位或改 key 就改 payload 重新匯入。
- **Jira 站台網址與負責人顏色住在 Convex 的 `config` 表**，不寫在程式裡；用
  `npx convex run data:setConfig` 設定（見 `docs/data-model.md`）。
- `convex/_generated/` 有進版控；改了 `convex/` 之後要讓 `convex dev`
  重新產生並一起提交。
- 日期一律用 ISO 字串比較（見 `src/lib/dates.ts`），避免時區偏移。
