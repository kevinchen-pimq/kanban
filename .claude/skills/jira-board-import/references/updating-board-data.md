# 更新看板資料

看板資料透過 payload JSON 檔匯入 Convex。匯入腳本住在 `.claude/skills/jira-board-import/scripts/import-board.mjs`，日常操作都走 npm alias：

```bash
npm run import -- <payload>.json --dry-run   # 只驗證，不寫入
npm run import -- <payload>.json             # 寫入 dev
npm run import -- <payload>.json --prod      # 寫入 production
npm run board                                # 看目前 dev 看板有什麼
npx convex run data:summary --prod           # 看 production 看板有什麼
```

拿掉整個 epic（連同它底下所有 ticket，checkpoint 列不動）：

```bash
npx convex run data:removeEpics '{"codes":["OLD-EPIC"]}'
```

匯入是**冪等**的——以自然鍵比對後 upsert（epic 用 `code`、週用 `weekNumber`、backlog 用 kind、ticket 用 `key`），同一份檔案重跑幾次結果都一樣。認證走 Convex CLI，不需要 deploy key，匯入相關的函式全部是 internal（`convex/data.ts`），瀏覽器叫不動。

看板本身也可以編輯：`convex/board.ts` 的 `board:*` mutation（換週次、同格排序、新增、修改、刪除）是公開且無認證的。這不影響匯入的正確性，但**匯入前後要記得 payload 才是事實來源**：

- 對某個 epic 重新匯入會把 `title` / `status` / `assignee` / `dueDate` / `tag` / `githubPrs` 與所在週次**蓋回 payload 的值**，手動改過的內容就沒了。要保留就寫回 payload。
- 帶 `pruneEpics` 的匯入會**刪掉 payload 沒有提到的卡片**，包含在看板上手動建立的（key 長得像 `LOCAL-3`）。真的要留下來，就在 payload 補上同 key 的 ticket。
- **格子內的排序（`order`）不會被匯入動到**，手動排過的順序在補充匯入之後還在；新匯入的卡片沒有 `order`，會排在該格已排序卡片的後面。

## 看板設定（不在 payload 裡）

Jira 站台網址與每個人的頭像顏色不走 payload，存在 Convex 的 `config` 表，用 internal mutation 設定（細節見 [docs/data-model.md](../../../../docs/data-model.md)）：

```bash
npx convex run data:getConfig                 # 先看現在設了什麼
npx convex run data:setConfig '{"jiraBaseUrl":"https://example.atlassian.net/browse"}'
npx convex run data:setConfig '{"assigneeColors":{"Some Person":"#7c2d12"}}'
```

匯入時會遇到的兩件事：**新 deployment 沒有設定過 `jiraBaseUrl`，卡片上的 key 就只是純文字**（第一次部署完記得設）；**匯入帶進了新的負責人**時，他會先拿到 hash 出來的顏色，要固定就把完整的 `assigneeColors` 名單重送一次（這個欄位是整份取代，不是合併）。

真實 payload 含工單標題、負責人姓名與內部 repo 連結，**不進版控**（`.gitignore` 擋掉 `data/*.json`）。它們的家是 **Google Drive 的 `Kanban` 資料夾**（用 Google Drive MCP 搜 `title = 'Kanban' and mimeType = 'application/vnd.google-apps.folder'` 就找得到）：匯入前從那裡下載到本地 `data/`，匯入成功後把更新過的 payload 傳回同一個資料夾，讓它保持是最新事實。`data/example-epic.json` 是唯一進版控的範例，內容全為虛構。

## payload 格式

```jsonc
{
  "epics":       [{ "code": "DEMO-BOARD", "name": "…", "accent": "purple" }],
  "checkpoints": [{ "kind": "week", "weekNumber": 34,
                    "startDate": "2026-08-25", "endDate": "2026-08-31" }],
  "tickets": [{
    "key": "DEMO-102",          // 自然鍵
    "title": "…",
    "epicCode": "DEMO-BOARD",   // 對應 epics[].code
    "checkpoint": 34,            // 週號，或 "backlog"
    "jiraStatus": "Dev Done",    // 或直接給 status: "testing"
    "dueDate": "2026-08-31",     // 以下皆可省略
    "githubPrs": ["https://github.com/owner/repo/pull/104"],
    "tag": "BE",
    "assignee": "alice"
  }],
  "pruneEpics": ["DEMO-BOARD"]  // 刪掉這些 epic 底下、payload 沒提到的 ticket
}
```

幾條容易踩錯的規則：

- **`jiraStatus` 必須對應得到燈號。** 對應表在 `.claude/skills/jira-board-import/scripts/jira-status.mjs`，沒對應到的狀態會直接讓匯入失敗，而不是套用預設值——靜默的預設會把真實工作丟進錯的燈號。Jira 出現新狀態時，把它加進那張表。
- **選填欄位沒給就會被清掉。** `dueDate` / `githubPrs` / `tag` / `assignee` 不會和資料庫裡的舊值合併——payload 永遠是那張卡的完整事實，這也是重跑安全的原因。卡片會自動省略缺席的欄位。
- **`pruneEpics` 讓 payload 成為那些 epic 的完整事實**：沒列在 payload 裡的 ticket 會被刪除。要做單一 epic 的全量重新同步就用它；只想補幾張卡就別加。
- **未知的 ticket 欄位會被驗證器拒絕。** 轉送給 Convex 的欄位是按名字挑的，`githubPr` 這種 typo 若不擋下來，會無聲丟掉所有 PR 連結。
- 檔頭用 `_source` / `_jql` / `_fetchedAt` / `_notes` 記錄來源與轉換時的判斷；`resolvedAt` 只存在檔案裡備查，不會寫進資料庫。

## 週次換算

週次是團隊自己的 checkpoint 編號（**週日到週六**，不是 ISO 週號），一律走腳本、不要心算：

```bash
npm run week -- 2026-07-24                    # 這天屬於哪一週
npm run week -- --windows 2026-04-07 2026-08-15   # JQL 週視窗
npm run week -- --checkpoints 11 29           # payload 的 checkpoints 條目
```

## 從 Jira 匯入

把某個 epic 上板的完整流程（列舉子票、判定週次、找 GitHub PR、產 payload、匯入驗證）見本 skill 的 [SKILL.md](../SKILL.md)。裡面記了幾個**不會報錯、只會給錯答案**的坑（Atlassian MCP 的 5 筆上限與 null cursor、GitHub 未加引號的票號搜尋），要動匯入流程前先讀它。
