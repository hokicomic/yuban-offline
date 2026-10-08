# 語伴發布規則

對使用者要求的程式功能、UI、播放邏輯或發布檔修改，完成工作前必須執行完整發布流程；不可只停在本機檔案修改。

1. 將 `yuban-original.jsx` 與 `語伴20260713.1-codex.js` 的 `APP_VERSION` 同步升為新的、遞增的版本字串。
2. 從 `main.jsx` 重新編譯 `app.js`；不可手動修改 bundle。
3. 檢查原始碼、獨立 JS 與 bundle 都含相同的新版號。
4. 執行語法檢查、相關自動測試與 `git diff --check`。
5. 僅將本次任務的預期檔案加入 Git，建立清楚的 commit，並推送到 `origin main`。
6. 推送後，以 `git ls-remote origin refs/heads/main` 驗證遠端 SHA 與本機 `HEAD` 完全相同。若連線失敗，不得宣稱已確認推送；必須清楚說明並在可行時重試。
7. 最終回覆必須列出版本、commit SHA、測試結果，以及 GitHub 遠端驗證結果。

只有在使用者明確要求「不要發布／不要推送」時，才可跳過第 5、6 步，並在回覆中明示未發布。
