# 專案結構與實作細節

## 專案結構

```
convex/
  schema.ts          資料表與共用 validator
  board.ts           board:get — 依時間區間回傳看板的單一 reactive query
  data.ts            importBoard / removeEpics / removeTickets / summary — 維運入口
  convex.config.ts   掛載 static-hosting component
src/
  lib/board.ts       型別、樣式對應表、checkpoint 與逾期的推導邏輯
  lib/dates.ts       ISO 日期工具（以字串比較避開時區偏移）
  lib/github.ts      PR 網址 → #編號 徽章文字
  components/        BoardHeader / BoardMatrix / TicketCard / StatusDot
                     MultiSelectFilter — 狀態與負責人共用的多選下拉
  components/ui/     shadcn/ui 元件
data/
  example-epic.json  合成的範例 payload（格式參考；真實 payload 不進版控）
docs/                本目錄：資料模型、專案結構、進度
.claude/skills/
  jira-board-import/ 從 Jira 匯入的 skill；匯入／週次／狀態對應腳本在它的 scripts/，
                     payload 格式與更新看板資料的說明在它的 references/
```

`convex/_generated/` 有進版控，所以剛 clone 下來不需要先登入 Convex 就能 `npm run build`。

## 時間區間與 lazy loading

`board.get` 收一個 `fromDate`（ISO 日期），只回傳**結束日在該日之後**的週次列與這些列的卡片，並附上 `hasOlder` 告訴前端還有沒有更早的資料。卡片是逐 checkpoint 走索引取，不是整張表掃出來再過濾，所以成本跟著視窗大小而不是資料總量。

前端首次只載入近 8 週，每次再往前拉 8 週，`hasOlder` 變 false 就停止請求並收起入口。四個實作細節：

- **開場捲到本週**：先載入的 8 週大多是歷史，停在最上面等於先給讀者最舊的一列。所以第一次拿到資料後會把本週那一列捲到欄位標題正下方（標題是 sticky，要扣掉它的高度否則會被蓋住）。只做一次，之後捲動位置就完全屬於讀者。若今天不落在任何一週（資料過期），就維持在最上面不動。
- **入口是按鈕，不只是捲動手勢**：看板初次繪製時 `scrollTop` 已經是 0，此時往上滑不會觸發 `scroll` 事件，單靠捲動偵測會讓讀者完全載不到更早的週次。所以頂端那一列是可點的按鈕，捲動偵測只是額外的便利路徑。
- **維持捲動位置**：往上補列會讓 `scrollHeight` 變大，若不處理，讀者會被推到頁面下方。所以在請求前記下「距底距離」，DOM 更新後用 `useLayoutEffect` 還原，原本在看的那幾列就留在原處。
- **不閃白**：Convex 的 `useQuery` 在參數改變時會先回 `undefined`。直接用會讓整個看板在載入更早週次時消失一瞬間，所以保留上一次的結果繼續畫，只在頂端顯示載入中。

## 版面

Header 固定 105px，分兩層：標題列與工具列（搜尋、狀態多選、負責人、重置）。

Y 軸的週欄位是 48px 寬的窄邊欄，標籤以 `writing-mode: vertical-rl` 轉 90 度顯示，讓週次資訊只佔垂直空間、把水平空間全部留給卡片。中文標籤必須同時設 `text-orientation: sideways`，否則預設會維持直立字形，再套 `rotate-180` 就會上下顛倒。

工具列有兩個多選篩選，共用 `MultiSelectFilter`：**狀態**與**負責人**。兩者都是不勾選代表不過濾（顯示全部），勾選則取聯集，彼此再取交集。狀態選單每一項都是「燈號 + 完整狀態名稱」，所以它同時是四個燈號的圖例。

負責人選項是從當下看板資料推導的，不是寫死的名單——選單裡不會出現沒有票的人。沒有負責人的票由「未指派」這個選項涵蓋（內部以 `null` 表示，不是佔位字串）。右側的計數在有篩選時顯示 `已顯示 / 總數`。
