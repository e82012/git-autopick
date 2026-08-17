# Git AutoPick

自動化處理多專案 `git cherry-pick` 的批次工具，提供直覺的 Web 介面與即時日誌串流，並具備完整的防護與失敗復原機制。

## 主要功能

*   **Worker Pool 佇列式併發處理**：支援自訂並發數量（Concurrency 1~10，預設 3），多專案平行處理 `switch/pull/fetch/cherry-pick/push`，顯著縮短批次處理總耗時。
*   **多專案批次選取**：透過現代版目錄選取器（Windows 原生對話框），一鍵選取多個本地專案進行批次執行。
*   **自動化復原 (Rollback)**：
    *   `switch/pull/fetch` 失敗：直接跳過該專案，避免副作用。
    *   `cherry-pick` 衝突：自動執行 `--abort` 清理狀態。
    *   `push` 失敗：自動執行 `reset --hard HEAD~1` 還原 commit。
*   **防呆與去重防護**：自動過濾重複目錄避免 Git lock 競爭；自動識別已存在的 commit；支援「模擬模式 (Dry-Run)」預演執行，不影響本地代碼。
*   **即時日誌串流分流**：Web 端基於 SSE 即時分組顯示各專案執行進度與終端機日誌，免刷新頁面且多專案平行執行時畫面不混亂。

## 應用技術

*   **後端 (Backend)**：Node.js (`Express`) + `child_process` (與 Git CLI 互動) + Worker Pool 併發調度
*   **前端 (Frontend)**：HTML / CSS / Vanilla JS (無框架)
*   **通訊技術**：Server-Sent Events (SSE) 單向即時資料流與多專案日誌分流
*   **系統整合**：PowerShell 腳本 (呼叫 WPF `OpenFileDialog` 實現現代化目錄選取)
*   **UI 設計**：基於 OKLCH 色彩空間的 Dark Luxury 工具型介面

## 執行方式

環境需求：必須安裝 **Node.js (v18+)** 與 **Git**。

### 方式一：一鍵啟動（推薦）
在專案根目錄，直接雙擊執行 `start.bat`。
*(批次檔會自動安裝依賴、啟動後端伺服器，並開啟瀏覽器)*

### 方式二：手動啟動
若需要透過終端機執行：

1.  **安裝依賴**
    ```bash
    npm install
    ```
2.  **啟動 Web 伺服器**
    ```bash
    npm run web
    ```
3.  **開啟網頁**
    在瀏覽器輸入網址：`http://localhost:3131`

---
**最後更新**: 2026-08-17
**維護者**: 開發團隊
**文件版本**: v1.1
**變更記錄**（里程碑，最多 5 條）:
- v1.1 (2026-08-17): 支援 Worker Pool 佇列式多專案併發 Cherry-Pick、目錄去重防護與並發數量設定
- v1.0 (2026-08-14): 初始版本，支援多專案批次循序 Cherry-Pick、自動 Rollback 與 Web UI 日誌串流
