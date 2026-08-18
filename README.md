# Epic × Checkpoint 看板

## 這是什麼

以 **Epic 為欄、週 Checkpoint 為列** 的矩陣式看板。和一般看板不同，X 軸是專案（Epic），Y 軸是每週 checkpoint，每個格子放該週該專案的工單卡片，一眼看出「每個專案在每一週各交付了什麼」。

技術棧：React + TypeScript + Vite + Tailwind v4 + shadcn/ui，後端與靜態網站託管都在 Convex 上。

## 為什麼要有這個專案

Jira 的看板以狀態為欄，回答的是「這張票現在在哪個階段」；但團隊每週檢視進度時要回答的是「**這一週各專案各做完了什麼**」——跨多個 epic、以週為粒度的交付視角，Jira 沒有現成的呈現方式。這個看板把 Jira 的工單資料重新以「專案 × 週」的矩陣排列，供每週 checkpoint 會議與進度回顧使用。

資料來源是 Jira（透過匯入流程同步上板），看板不回寫 Jira。看板本身也能編輯——拖曳換週次或排序、新增／修改／刪除卡片、點燈號換狀態——但 payload 仍是事實來源，之後對該 epic 完整重新匯入時會蓋掉手動的調整。

看板前面有一層簡單的帳號密碼登入：讀看板要 `permRead`，編輯要 `permWrite`，註冊之後要有權限的人按通過才進得來（見 [docs/data-model.md](docs/data-model.md) 的「登入與權限」）。

## 在哪裡可以用到

| 環境 | 網站 |
| --- | --- |
| Production | https://lovely-jackal-885.convex.site |
| Development | https://laudable-buffalo-595.convex.site |

各 deployment 的 dashboard 從 `npx convex dashboard` 開，不寫在這裡。

## 開始開發

```bash
npm install
npx convex dev                              # 首次會要求登入，並寫入 .env.local
npm run import -- data/example-epic.json    # 灌入範例資料
npm run dev                                 # 同時起 Vite (5173) 與 convex dev
```

常用指令：

```bash
npm run dev          # 前端 dev server + convex dev 並行
npm run typecheck    # tsc -b
npm run build        # 型別檢查 + 建置前端
npm run board        # 看目前 dev 看板有什麼
npm run deploy       # 建置 + 後端推上 production + 上傳靜態檔
npm run deploy:dev   # 先在 dev deployment 做煙霧測試
```

`npm run deploy` 一次做完三件事：用 production 的 `VITE_CONVEX_URL` 建置前端 → 把後端推上 production → 把 `dist/` 上傳到 Convex 靜態託管。新的 production deployment 資料庫是空的，第一次部署後要灌資料（見下方文件）。

## 更多文件

| 文件 | 內容 |
| --- | --- |
| [docs/data-model.md](docs/data-model.md) | 資料模型：五張表、狀態燈號、登入與權限、刻意的設計決定 |
| [docs/architecture.md](docs/architecture.md) | 專案結構與前端實作細節（lazy loading、版面） |
| [docs/progress.md](docs/progress.md) | 當前進度與尚未實作的範圍 |
| [.claude/skills/jira-board-import/](.claude/skills/jira-board-import/SKILL.md) | 從 Jira 匯入 epic 的完整流程；匯入腳本與 [payload 格式／更新看板資料](.claude/skills/jira-board-import/references/updating-board-data.md) 都在這裡 |

給 AI Agent 的入口是 [CLAUDE.md](CLAUDE.md) 與 [AGENTS.md](AGENTS.md)。
