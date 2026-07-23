# Git AutoPick

自動化處理多專案 `git cherry-pick` 的批次工具，提供直覺的 Web 介面與即時日誌串流，並具備完整的防護與失敗復原機制。

## 主要功能

*   **多專案批次處理**：透過現代版目錄選取器（Windows 原生對話框），一鍵選取多個本地專案進行批次執行。
*   **自動化復原 (Rollback)**：
    *   `switch/pull/fetch` 失敗：直接跳過該專案，避免副作用。
    *   `cherry-pick` 衝突：自動執行 `--abort` 清理狀態。
    *   `push` 失敗：自動執行 `reset --hard HEAD~1` 還原 commit。
*   **防呆與防錯**：自動過濾已存在的 commit；支援「模擬模式 (Dry-Run)」預演執行，不影響本地代碼。
*   **即時日誌串流**：Web 端即時顯示終端機的執行進度，免刷新頁面。

## 應用技術

*   **後端 (Backend)**：Node.js (`Express`) + `child_process` (與 Git CLI 互動)
*   **前端 (Frontend)**：HTML / CSS / Vanilla JS (無框架)
*   **通訊技術**：Server-Sent Events (SSE) 單向即時資料流
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
