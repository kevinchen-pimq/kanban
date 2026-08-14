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

## 文件地圖

| 要做的事 | 先讀 |
| --- | --- |
| 了解專案、啟動開發 | `README.md` |
| 更新看板資料、payload 格式 | `docs/updating-board-data.md` |
| 動 schema 或狀態燈號 | `docs/data-model.md` |
| 改前端（lazy loading、版面）或找檔案 | `docs/architecture.md` |
| 確認做到哪、還缺什麼 | `docs/progress.md` |
| 把 Jira epic 上板、改匯入流程 | `.claude/skills/jira-board-import/SKILL.md`（用 skill，別自己重推流程） |

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
