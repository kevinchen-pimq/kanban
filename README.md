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

## 更新看板資料

`seed:run` 只會重播原始的 PoC 範例,要放真實資料請用匯入流程。

```bash
node scripts/import-board.mjs data/example-epic.json --dry-run   # 只驗證,不寫入
npm run import -- data/example-epic.json                          # 寫入 dev
node scripts/import-board.mjs data/example-epic.json --prod       # 寫入 production
npm run board                                                 # 看目前看板有什麼
```

匯入是**冪等**的 —— 以自然鍵比對後 upsert(epic 用 `code`、週用 `weekNumber`、backlog 用 kind、ticket 用 `key`),同一份檔案重跑幾次結果都一樣。認證走 Convex CLI,不需要 deploy key,也沒有任何對外開放的寫入端點(`convex/data.ts` 全是 internal function)。

### payload 格式

```jsonc
{
  "epics":       [{ "code": "DEMO-BOARD", "name": "…", "accent": "purple" }],
  "checkpoints": [{ "kind": "week", "weekNumber": 34,
                    "startDate": "2026-08-25", "endDate": "2026-08-31" }],
  "tickets": [{
    "key": "ABC-0000",           // 自然鍵
    "title": "…",
    "epicCode": "DEMO-BOARD",  // 對應 epics[].code
    "checkpoint": 34,            // 週號,或 "backlog"
    "jiraStatus": "Dev Done",    // 或直接給 status: "testing"
    "tag": "BE",
    "dueDate": "2026-08-31",     // 可省略
    "assignee": "alice"
  }],
  "pruneEpics": ["DEMO-BOARD"] // 刪掉這些 epic 底下、payload 沒提到的 ticket
}
```

`jiraStatus` 會透過 `scripts/jira-status.mjs` 對應到四個燈號之一。**沒對應到的狀態會直接讓匯入失敗**,而不是套用預設值 —— 靜默的預設會把真實工作丟進錯的燈號。Jira 出現新狀態時,把它加進那張表。

`pruneEpics` 讓 payload 成為那些 epic 的完整事實:沒列在 payload 裡的 ticket 會被刪除。要做單一 epic 的全量重新同步就用它;只想補幾張卡就別加。

### 從 Jira 匯入

Jira 那一段目前是手動的:我透過 Atlassian MCP 讀 `parent = <EPIC-KEY>`,把結果寫成上面格式的 JSON 存進 `data/`,再跑匯入腳本。`data/example-epic.json` 就是這樣產生的,檔頭的 `_source` / `_jql` / `_notes` 記錄了它的來源與轉換規則。

## 資料模型

`convex/schema.ts` 三張表:

- **`epics`** — X 軸的欄。`code`(如 `E2E-TEST`)、`name`、`accent` 顏色鍵、`order` 決定左右順序。
- **`checkpoints`** — Y 軸的列。`kind` 是 `week` 或 `backlog`;週別存 `weekNumber` 與 `startDate`/`endDate`(ISO 日期字串)。
- **`tickets`** — 卡片。以 `epicId` + `checkpointId` 決定落在哪一格,`status` 是四個燈號之一。

### 兩個刻意的設計決定

**「本週」是算出來的,不是存的。** checkpoint 只存起訖日期,`src/lib/board.ts` 的 `describeCheckpoints()` 用今天的日期判斷每一列的相對位置(`current` / `previous` / `next` / `past` / `future` / `backlog`),看板據此把本週那一列標成靛藍色左邊框並淡染背景。所以每週不需要手動改資料。相鄰關係是用日期距離推出來的,即使中間缺了某一週,判斷仍然正確。

注意 `weekNumber` 是團隊自己的 checkpoint 編號,**不是 ISO 週號**(W31 對應的 ISO 週其實是 32),而且一週的區間是週二到週一 —— 所以編號用存的,不用算的。

**逾期也是算出來的。** 卡片沒有 `isOverdue` 欄位;`isOverdue()` 判斷 `dueDate` 早於今天且狀態不是 `done`,所以紅色標籤不會過期失準。

### 狀態燈號

| 燈號 | 值 | 涵蓋 |
| --- | --- | --- |
| 灰 | `todo` | To Do / Backlog |
| 藍 | `doing` | Doing |
| 黃 | `testing` | Test and Review / Dev Done |
| 綠 | `done` | Dev Test Done / Done |

## 版面

Header 固定 105px,分兩層:標題列與工具列(搜尋、狀態多選、負責人、重置)。

Y 軸的週欄位是 48px 寬的窄邊欄,標籤以 `writing-mode: vertical-rl` 轉 90 度顯示,讓週次資訊只佔垂直空間、把水平空間全部留給卡片。中文標籤必須同時設 `text-orientation: sideways`,否則預設會維持直立字形,再套 `rotate-180` 就會上下顛倒。

狀態篩選是多選:不勾選代表不過濾(顯示全部),勾選則只顯示選中的狀態。選單每一項都是「燈號 + 完整狀態名稱」,所以它同時是四個燈號的圖例。

## 專案結構

```
convex/
  schema.ts          資料表與共用 validator
  board.ts           board:get — 看板的單一 reactive query
  seed.ts            seed:run — 重播原始 PoC 範例資料
  data.ts            importBoard / removeTickets / summary — 真實資料的維運入口
  convex.config.ts   掛載 static-hosting component
scripts/
  import-board.mjs   驗證 payload 並呼叫 data:importBoard
  jira-status.mjs    Jira 狀態名稱 → 四個燈號
data/
  example-epic.json      從 Jira epic ABC-0000 匯出的 27 張工單
src/
  lib/board.ts       型別、樣式對應表、checkpoint 與逾期的推導邏輯
  lib/dates.ts       ISO 日期工具(以字串比較避開時區偏移)
  components/        BoardHeader / BoardMatrix / TicketCard / StatusDot
  components/ui/     shadcn/ui 元件
```

`convex/_generated/` 有進版控,所以剛 clone 下來不需要先登入 Convex 就能 `npm run build`。

## 目前範圍

第一階段只做唯讀呈現:資料從 Convex 讀出來、渲染矩陣、前端做搜尋與狀態篩選。**尚未實作**權限、新增/編輯、拖曳、以及點卡片開詳情 modal。
