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
npx convex dev                          # 首次會要求登入,並寫入 .env.local
npm run import -- data/example-epic.json    # 灌入看板資料
npm run import -- data/example-epic.json
npm run dev                             # 同時起 Vite (5173) 與 convex dev
```

`npm run dev` 會並行跑前端 dev server 與 `convex dev`,後者持續同步 `convex/` 的變更並重新產生型別。

## 部署

```bash
npm run deploy
```

一次做完三件事:用 production 的 `VITE_CONVEX_URL` 建置前端 → 把後端推上 production → 把 `dist/` 上傳到 Convex 靜態託管。

新的 production deployment 資料庫是空的,第一次部署後要灌資料:

```bash
node scripts/import-board.mjs data/example-epic.json --prod
node scripts/import-board.mjs data/example-epic.json --prod
```

想先在 dev deployment 上做煙霧測試(驗證 HTTP 路由、快取標頭、SPA fallback):

```bash
npm run deploy:dev
```

## 更新看板資料

```bash
node scripts/import-board.mjs data/example-epic.json --dry-run   # 只驗證,不寫入
npm run import -- data/example-epic.json                          # 寫入 dev
node scripts/import-board.mjs data/example-epic.json --prod       # 寫入 production
npm run board                                                 # 看目前看板有什麼
```

拿掉整個 epic(連同它底下所有 ticket,checkpoint 列不動):

```bash
npx convex run data:removeEpics '{"codes":["OLD-EPIC"]}'
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
    "dueDate": "2026-08-31",     // 以下皆可省略
    "githubPrs": ["https://github.com/owner/repo/pull/9097"],
    "tag": "BE",
    "assignee": "alice"
  }],
  "pruneEpics": ["DEMO-BOARD"] // 刪掉這些 epic 底下、payload 沒提到的 ticket
}
```

`jiraStatus` 會透過 `scripts/jira-status.mjs` 對應到四個燈號之一。**沒對應到的狀態會直接讓匯入失敗**,而不是套用預設值 —— 靜默的預設會把真實工作丟進錯的燈號。Jira 出現新狀態時,把它加進那張表。

`pruneEpics` 讓 payload 成為那些 epic 的完整事實:沒列在 payload 裡的 ticket 會被刪除。要做單一 epic 的全量重新同步就用它;只想補幾張卡就別加。

`dueDate` / `githubPrs` / `tag` / `assignee` 都是選填,**沒給就會被清掉**(不是保留舊值),所以 payload 永遠是那張卡的完整事實。卡片會自動省略缺席的欄位。

### 從 Jira 匯入

整套流程寫成了 skill:`.claude/skills/jira-board-import/`。要把某個 epic 上板時直接用它,裡面記了下面這些規則,以及幾個**不會報錯、只會給錯答案**的坑(MCP 的 5 筆上限與 null cursor、GitHub 未加引號的搜尋)。

週次換算一律走腳本,不要心算:

```bash
node scripts/checkpoint-week.mjs 2026-07-24              # 這天屬於哪一週
node scripts/checkpoint-week.mjs --windows 2026-04-07 2026-08-15   # JQL 週視窗
node scripts/checkpoint-week.mjs --checkpoints 11 29     # payload 的 checkpoints
```

Jira 那一段目前是手動的:透過 Atlassian MCP 讀 `parent = <EPIC-KEY>`,把結果寫成上面格式的 JSON 存進 `data/`,再跑匯入腳本。`data/example-epic.json` 與 `data/example-epic.json` 都是這樣產生的,檔頭的 `_source` / `_jql` / `_notes` 記錄了來源與每一項轉換規則。

**Atlassian MCP 的分頁上限**:`searchJiraIssuesUsingJql` 每次最多只回 5 筆,而且超過時 `pageInfo.endCursor` 是 `null` —— 沒有游標可以往下翻。要拿完整清單就看 `remainingCount`(它給的是真正的總數),再用 `AND key NOT IN (已取得的 key…)` 把已知的排掉重跑。另外指定 `fields` 並不會擋掉 `description`,描述很長的 epic 要有心理準備。

**checkpoint 的判定**:目前不使用 Jira 的 sprint 欄位,而是看這張票**是在哪一週被切成 Dev Done**。用 JQL 逐週查:

```
parent = <EPIC-KEY> AND status CHANGED TO "Dev Done" DURING ("<週二>", "<下個週二>")
```

一張票可能出現在多個週視窗(被打回後再次切 Dev Done),此時取**最後**一次 —— 那是真正生效的那一次。

**沒有 Dev Done 的票改看 resolution date。** spec、prototype、設計稿、測試案例、POC 這類工作根本不經過 Dev Done 欄位,只靠第一條規則會讓它們即使在 Jira 已經 Done 也全部堆進 backlog。所以第二步改用 Jira 的 resolution date 決定週次,並把來源日期記在該張票的 `resolvedAt` 欄位裡備查(這個欄位只存在檔案中,不會寫進資料庫)。

兩條都沒有的票才留在 backlog —— 那是真正還沒做完的工作該待的地方。ABC-0000 的 12 張 backlog 票就是這種情況(Issue Open / Doing / Ready for Review,皆未 resolved)。

**PR 連結的來源**:Jira 的 development panel 沒有透過 Atlassian MCP 開放(`getJiraIssueRemoteIssueLinks` 回傳 `[]`),`gh` CLI 沒安裝,直接打 api.github.com 也被 proxy 擋(403)。可行的是 GitHub MCP 的 PR 搜尋,它可以直接指定 repo,不需要 `add_repo`(後者拒絕跨 owner 掛載):

```
repo:<owner>/<repo> "ABC-0000"
```

**票號一定要加引號。** 不加引號時 GitHub 會把 `ABC-0000` 拆成 `ca` + `15893`,曾誤中一個早於該票、不可能引用它的 PR #7314。

搜到的是「內文提及該票號」的 PR,不等於「實作它」的 PR,而且一張票可能對到多個(所以欄位是 `githubPrs` 陣列)。

## 資料模型

`convex/schema.ts` 三張表:

- **`epics`** — X 軸的欄。`code`(如 `DEMO-BOARD`)、`name`、`accent` 顏色鍵、`order` 決定左右順序。
- **`checkpoints`** — Y 軸的列。`kind` 是 `week` 或 `backlog`;週別存 `weekNumber` 與 `startDate`/`endDate`(ISO 日期字串)。**列的順序由日期推導**,不看 payload 給的 `order` —— 週次有真實日期,從日期排就不可能因為匯入時 `order` 給錯而排亂(這個錯我自己踩過)。backlog 永遠在最後。
- **`tickets`** — 卡片。以 `epicId` + `checkpointId` 決定落在哪一格,`status` 是四個燈號之一。`assignee` / `dueDate` / `githubPrs` / `tag` 皆為選填。

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

## 時間區間與 lazy loading

`board.get` 收一個 `fromDate`(ISO 日期),只回傳**結束日在該日之後**的週次列與這些列的卡片,並附上 `hasOlder` 告訴前端還有沒有更早的資料。卡片是逐 checkpoint 走索引取,不是整張表掃出來再過濾,所以成本跟著視窗大小而不是資料總量。

前端首次只載入近 8 週,每次再往前拉 8 週,`hasOlder` 變 false 就停止請求並收起入口。四個實作細節:

- **開場捲到本週**:先載入的 8 週大多是歷史,停在最上面等於先給讀者最舊的一列。所以第一次拿到資料後會把本週那一列捲到欄位標題正下方(標題是 sticky,要扣掉它的高度否則會被蓋住)。只做一次,之後捲動位置就完全屬於讀者。若今天不落在任何一週(資料過期),就維持在最上面不動。
- **入口是按鈕,不只是捲動手勢**:看板初次繪製時 `scrollTop` 已經是 0,此時往上滑不會觸發 `scroll` 事件,單靠捲動偵測會讓讀者完全載不到更早的週次。所以頂端那一列是可點的按鈕,捲動偵測只是額外的便利路徑。
- **維持捲動位置**:往上補列會讓 `scrollHeight` 變大,若不處理,讀者會被推到頁面下方。所以在請求前記下「距底距離」,DOM 更新後用 `useLayoutEffect` 還原,原本在看的那幾列就留在原處。
- **不閃白**:Convex 的 `useQuery` 在參數改變時會先回 `undefined`。直接用會讓整個看板在載入更早週次時消失一瞬間,所以保留上一次的結果繼續畫,只在頂端顯示載入中。

## 版面

Header 固定 105px,分兩層:標題列與工具列(搜尋、狀態多選、負責人、重置)。

Y 軸的週欄位是 48px 寬的窄邊欄,標籤以 `writing-mode: vertical-rl` 轉 90 度顯示,讓週次資訊只佔垂直空間、把水平空間全部留給卡片。中文標籤必須同時設 `text-orientation: sideways`,否則預設會維持直立字形,再套 `rotate-180` 就會上下顛倒。

工具列有兩個多選篩選,共用 `MultiSelectFilter`:**狀態**與**負責人**。兩者都是不勾選代表不過濾(顯示全部),勾選則取聯集,彼此再取交集。狀態選單每一項都是「燈號 + 完整狀態名稱」,所以它同時是四個燈號的圖例。

負責人選項是從當下看板資料推導的,不是寫死的名單 —— 選單裡不會出現沒有票的人。沒有負責人的票由「未指派」這個選項涵蓋(內部以 `null` 表示,不是佔位字串)。右側的計數在有篩選時顯示 `已顯示 / 總數`。

## 專案結構

```
convex/
  schema.ts          資料表與共用 validator
  board.ts           board:get — 依時間區間回傳看板的單一 reactive query
  data.ts            importBoard / removeEpics / removeTickets / summary — 維運入口
  convex.config.ts   掛載 static-hosting component
scripts/
  import-board.mjs    驗證 payload 並呼叫 data:importBoard
  jira-status.mjs     Jira 狀態名稱 → 四個燈號
  checkpoint-week.mjs 日期 ↔ 週次、JQL 週視窗、checkpoint 條目
data/
  example-epic.json      從 Jira epic ABC-0000 匯出的 27 張工單
  example-epic.json      從 Jira epic ABC-0000 匯出的 39 張工單
src/
  lib/board.ts       型別、樣式對應表、checkpoint 與逾期的推導邏輯
  lib/dates.ts       ISO 日期工具(以字串比較避開時區偏移)
  lib/github.ts      PR 網址 → #編號 徽章文字
  components/        BoardHeader / BoardMatrix / TicketCard / StatusDot
                     MultiSelectFilter — 狀態與負責人共用的多選下拉
  components/ui/     shadcn/ui 元件
```

`convex/_generated/` 有進版控,所以剛 clone 下來不需要先登入 Convex 就能 `npm run build`。

## 目前範圍

第一階段只做唯讀呈現:資料從 Convex 讀出來、渲染矩陣、前端做搜尋與狀態/負責人篩選。**尚未實作**權限、新增/編輯、拖曳、以及點卡片開詳情 modal。
