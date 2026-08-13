# Epic × Checkpoint 看板

以 **Epic 為欄、週 Checkpoint 為列** 的矩陣式看板。和一般看板不同,X 軸是專案(Epic),Y 軸是每週 checkpoint,每個格子放該週該專案的工單卡片。

React + TypeScript + Vite + Tailwind v4 + shadcn/ui,後端與靜態網站託管都在 Convex 上。

## 線上位置

| 環境 | 網站 | Convex Dashboard |
| --- | --- | --- |
| Production | https://lovely-jackal-885.convex.site | [kanban / production](https://dashboard.convex.dev/t/example-team/kanban/lovely-jackal-885) |
| Development | https://laudable-buffalo-595.convex.site | [kanban / dev](https://dashboard.convex.dev/t/example-team/kanban/laudable-buffalo-595) |

## 開始開發

```bash
npm install
npx convex dev      # 首次會要求登入,並寫入 .env.local
npm run seed        # 灌入看板範例資料
npm run dev         # 同時起 Vite (5173) 與 convex dev
```

`npm run dev` 會並行跑前端 dev server 與 `convex dev`,後者持續同步 `convex/` 的變更並重新產生型別。

## 部署

```bash
npm run deploy
```

一次做完三件事:用 production 的 `VITE_CONVEX_URL` 建置前端 → 把後端推上 production → 把 `dist/` 上傳到 Convex 靜態託管。

新的 production deployment 資料庫是空的,第一次部署後要灌資料:

```bash
npx convex run seed:run --prod
```

想先在 dev deployment 上做煙霧測試(驗證 HTTP 路由、快取標頭、SPA fallback):

```bash
npm run deploy:dev
```

## 資料模型

`convex/schema.ts` 三張表:

- **`epics`** — X 軸的欄。`code`(如 `E2E-TEST`)、`name`、`accent` 顏色鍵、`order` 決定左右順序。
- **`checkpoints`** — Y 軸的列。`kind` 是 `week` 或 `backlog`;週別存 `weekNumber` 與 `startDate`/`endDate`(ISO 日期字串)。
- **`tickets`** — 卡片。以 `epicId` + `checkpointId` 決定落在哪一格,`status` 是四個燈號之一。

### 兩個刻意的設計決定

**「本週」是算出來的,不是存的。** checkpoint 只存起訖日期,`src/lib/board.ts` 的 `describeCheckpoints()` 用今天的日期判斷哪一列是「本週主推」,相鄰的則標為「前週完成」與「下週預計」。所以每週不需要手動改資料。相鄰關係是用日期距離推出來的,即使中間缺了某一週,標示仍然正確。

注意 `weekNumber` 是團隊自己的 checkpoint 編號,**不是 ISO 週號**(W31 對應的 ISO 週其實是 32),而且一週的區間是週二到週一 —— 所以編號用存的,不用算的。

**逾期也是算出來的。** 卡片沒有 `isOverdue` 欄位;`isOverdue()` 判斷 `dueDate` 早於今天且狀態不是 `done`,所以紅色標籤不會過期失準。

### 狀態燈號

| 燈號 | 值 | 涵蓋 |
| --- | --- | --- |
| 灰 | `todo` | To Do / Backlog |
| 藍 | `doing` | Doing |
| 黃 | `testing` | Test and Review / Dev Done |
| 綠 | `done` | Dev Test Done / Done |

## 專案結構

```
convex/
  schema.ts          資料表與共用 validator
  board.ts           board:get — 看板的單一 reactive query
  seed.ts            seed:run — 冪等的範例資料寫入
  convex.config.ts   掛載 static-hosting component
src/
  lib/board.ts       型別、樣式對應表、checkpoint 與逾期的推導邏輯
  lib/dates.ts       ISO 日期工具(以字串比較避開時區偏移)
  components/        BoardHeader / BoardMatrix / TicketCard / StatusDot
  components/ui/     shadcn/ui 元件
```

`convex/_generated/` 有進版控,所以剛 clone 下來不需要先登入 Convex 就能 `npm run build`。

## 目前範圍

第一階段只做唯讀呈現:資料從 Convex 讀出來、渲染矩陣、前端做搜尋與狀態篩選。**尚未實作**權限、新增/編輯、拖曳、以及點卡片開詳情 modal。
