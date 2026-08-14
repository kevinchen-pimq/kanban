# Agent guide

Epic × Checkpoint 看板：Epic 為欄、週 checkpoint 為列的矩陣看板。前端 React +
TypeScript + Vite + Tailwind v4 + shadcn/ui，後端與靜態託管都在 Convex。
看板唯讀，資料由匯入腳本寫入，不回寫 Jira。

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
| 確認做到哪、還缺什麼 | `docs/progress.md` |
| 把 Jira epic 上板、改匯入流程 | `.claude/skills/jira-board-import/SKILL.md`（用 skill，別自己重推流程） |

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
- **真實 payload 不進版控**（`data/*.json` 被 gitignore，`data/example-epic.json`
  是唯一的合成範例）。不要把真實工單標題、姓名、內部 repo 連結寫進 repo。
- **週次換算一律跑 `npm run week`，不要心算。** `weekNumber` 是團隊編號
  （週二到週一），不是 ISO 週號。
- **未知的 Jira 狀態要加進對應表**（skill 的 `scripts/jira-status.mjs`），
  不要在 payload 裡硬塞 `status` 繞過去；匯入失敗是刻意設計。
- **checkpoint 列順序由日期推導**，`convex/board.ts` 會忽略 payload 的
  `order`——看到「列排錯」先想到這裡，不是 bug。
- `convex/_generated/` 有進版控；改了 `convex/` 之後要讓 `convex dev`
  重新產生並一起提交。
- 日期一律用 ISO 字串比較（見 `src/lib/dates.ts`），避免時區偏移。
