# 專案結構與實作細節

## 專案結構

```
convex/
  schema.ts          資料表與共用 validator
  board.ts           board:get — 依時間區間回傳看板（含 config）的單一 reactive query
                     board:moveTicket — 唯一的公開寫入（拖曳改週次，無認證）
  staticHosting.ts   re-export static-hosting component 的 deployment query
  data.ts            importBoard / removeEpics / removeTickets / summary — 維運入口
                     setConfig / getConfig — 看板設定（internal）
  convex.config.ts   掛載 static-hosting component
src/
  lib/board.ts       型別、樣式對應表、checkpoint 與逾期的推導邏輯
  lib/dates.ts       ISO 日期工具（以字串比較避開時區偏移）
  lib/github.ts      PR 網址 → #編號 徽章文字
  lib/jira.ts        ticket key + config 的 base URL → Jira 網址（沒設定就回 null）
  lib/assignee.ts    負責人頭像的縮寫與顏色（config 指定優先，其次姓名 hash）
  lib/scroll.ts      捲到本週那一列（開場自動捲動與按鈕共用）
  lib/dnd.ts         拖曳的資料型別、暫存區 id、碰撞判定
  components/        BoardHeader / BoardMatrix / TicketCard / StatusDot
                     MultiSelectFilter — 狀態與負責人共用的多選下拉
                     AssigneeAvatar — 卡片與篩選選單共用的負責人頭像
                     BoardConfigProvider — 看板設定的 context（來自 board:get）
                     DraggableTicket / StagingTray — 拖曳與暫存區
                     UpdateNotice — 有新版本時的重新載入提示
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

- **開場捲到本週**：先載入的 8 週大多是歷史，停在最上面等於先給讀者最舊的一列。所以第一次拿到資料後會把本週那一列捲到欄位標題正下方（標題是 sticky，要扣掉它的高度否則會被蓋住）。只做一次，之後捲動位置就完全屬於讀者——要回到本週，用左上角落格的按鈕。按鈕和開場捲動共用 `scrollToCurrentWeek()`（`src/lib/scroll.ts`），所以兩者停在完全相同的位置；資料裡沒有本週時它回傳 false，按鈕也就直接 disabled。
- **入口是按鈕，不只是捲動手勢**：看板初次繪製時 `scrollTop` 已經是 0，此時往上滑不會觸發 `scroll` 事件，單靠捲動偵測會讓讀者完全載不到更早的週次。所以頂端那一列是可點的按鈕，捲動偵測只是額外的便利路徑。
- **維持捲動位置**：往上補列會讓 `scrollHeight` 變大，若不處理，讀者會被推到頁面下方。所以在請求前記下「距底距離」，DOM 更新後用 `useLayoutEffect` 還原，原本在看的那幾列就留在原處。
- **不閃白**：Convex 的 `useQuery` 在參數改變時會先回 `undefined`。直接用會讓整個看板在載入更早週次時消失一瞬間，所以保留上一次的結果繼續畫，只在頂端顯示載入中。

## 版面

Header 固定 105px，分兩層：標題列與工具列（搜尋、狀態多選、負責人、重置）。

Y 軸的週欄位是 48px 寬的窄邊欄，標籤以 `writing-mode: vertical-rl` 轉 90 度顯示，讓週次資訊只佔垂直空間、把水平空間全部留給卡片。中文標籤必須同時設 `text-orientation: sideways`，否則預設會維持直立字形，再套 `rotate-180` 就會上下顛倒。

工具列有兩個多選篩選，共用 `MultiSelectFilter`：**狀態**與**負責人**。兩者都是不勾選代表不過濾（顯示全部），勾選則取聯集，彼此再取交集。狀態選單每一項都是「燈號 + 完整狀態名稱」，所以它同時是四個燈號的圖例。

負責人選項是從當下看板資料推導的，不是寫死的名單——選單裡不會出現沒有票的人。沒有負責人的票由「未指派」這個選項涵蓋（內部以 `null` 表示，不是佔位字串）。右側的計數在有篩選時顯示 `已顯示 / 總數`。

## 負責人顏色與 Jira 連結

負責人以圓形頭像呈現：白色縮寫字疊在一個屬於這個人的顏色上（`AssigneeAvatar`）。顏色照這個順序決定（`src/lib/assignee.ts`）：

1. **`config.assigneeColors` 指定的顏色**——團隊現有成員都在這裡，一人一色、手動指定、不會變。
2. **姓名 hash 進 10 色調色盤**——名單裡沒有的人（例如剛加入、還沒有人去設定）也會拿到一個穩定的顏色：同一個姓名（去空白、轉小寫）在任何 deployment、任何 session 都 hash 到同一個顏色，不受載入順序影響。

兩層都不依賴渲染順序，所以掃一整欄找「這是誰的卡」才有意義。調色盤每個顏色都通過白字 4.5:1 的對比檢查；未指派用中性的 slate。fallback 的顏色有機會和某個指定顏色相同（10 色的必然結果）——真的在意就把那個人加進 config。

顏色是行內 style 而不是 Tailwind class：兩層的值都是執行期才知道，Tailwind 掃不到就不會產生對應的 CSS。

卡片的 key 連到 `config.jiraBaseUrl` + key（`jiraIssueUrl()` 容忍結尾多餘的斜線）。**沒有設定 base URL 時 key 就是純文字**，不做成會 404 的連結。連結會 `stopPropagation` pointerdown，所以點連結不會變成拖曳的開始。

## 拖曳改週次與暫存區

拖曳用 `@dnd-kit/core`：`DndContext` 在 `App`，卡片是 `DraggableTicket`，每個 (checkpoint, epic) 格子是 droppable。四個要點：

- **只能上下移動，不能左右換欄。** 格子在 hover 時自己比對「拖曳中的卡片是哪個 epic」：同欄標靛藍並顯示「放這裡」，別的 epic 標紅顯示「不能跨 Epic」且放下無效。同一條規則在 `board:moveTicket` 再驗一次，前端的視覺提示不是唯一的防線。
- **暫存區。** 拖曳一開始，畫面底部中央會出現暫存區；把卡片丟進去就先從矩陣裡「拿起來」（純前端狀態，沒有任何寫入），捲到目標週次後再從暫存區拖出去放。暫存區在還有卡片或還在拖曳時保持顯示。它浮在矩陣上方，所以碰撞判定用 `trayFirstCollision`：指標落在暫存區內時，優先給暫存區，不然 `pointerWithin` 有機會把 drop 判給底下被遮住的格子。
- **暫存區的卡片還沒有移動。** 只有放進格子才會呼叫 mutation；關掉分頁等於什麼都沒發生。每張暫存卡片記著自己的 epic，所以繞這一圈之後同欄限制照樣成立。
- **樂觀更新。** 放下的瞬間先用 `withOptimisticUpdate` 就地把 `checkpointId` 改掉，卡片同一個 frame 就出現在新的列，不用等 round trip；失敗時 Convex 會自己回滾，前端在底部顯示紅色訊息。暫存卡片是從整個時間窗（不是篩選後的清單）推導出來的，所以改篩選不會讓暫存的卡片憑空消失。

篩選開著時拖曳操作的是「看得到的卡片」——被篩掉的卡片不在畫面上，也就不會被拖到。

## 有新版本時的提示

看板是那種「開著一整週不關」的頁面，所以部署了新版本要講出來，否則使用者會一直看著週一載入的那份 bundle。

static-hosting component 自己記著「現在服務的是哪一次部署」，`convex/staticHosting.ts` 把它的 query re-export 成 `staticHosting:getCurrentDeployment`（**公開唯讀**，不是寫入端點）。前端的 `UpdateNotice` 用 component 提供的 `useDeploymentUpdates()` 訂閱它：hook 記住首次繪製時看到的 deployment id，只有在 id 改變時才回報有更新——所以正常開頁面不會跳提示，只有在你開著頁面時有人部署才會。提示可以按「重新載入」或關掉（關掉只針對這一次部署）。

提示條是自己做的，不是 component 內建的 `UpdateBanner`：內建那個帶自己的 inline style 與英文文案。自製的版本長得像看板的其他元件，而且定位在 `<main>` 上（`absolute`），所以不需要知道 header 有多高，也不會和底部的拖曳暫存區疊在一起。
