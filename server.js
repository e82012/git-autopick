/**
 * server.js — Git AutoPick Web Server
 *
 * 提供：
 *  - 靜態檔案服務（web/ 目錄）
 *  - POST /api/run   → 接收參數，執行 cherry-pick，透過 SSE 串流回傳 log
 *  - GET  /api/ping  → 健康檢查
 */

import express from 'express';
import { EventEmitter } from 'events';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCherryPickFlow, STATUS } from './src/cherryPickFlow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3131;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// ── 健康檢查 ──────────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => res.json({ ok: true }));

// ── 目錄選取端點 ──────────────────────────────────────────────────────────
import { spawn } from 'child_process';
app.get('/api/select-folder', (req, res) => {
  const psScript = `
    Add-Type -AssemblyName PresentationFramework
    $dlg = New-Object Microsoft.Win32.OpenFileDialog
    $dlg.Title = "請進入專案目錄後，點擊右下角『開啟』"
    $dlg.FileName = "選擇目前的資料夾"
    $dlg.Filter = "資料夾|*.directory_selection_placeholder"
    $dlg.CheckFileExists = $false
    $dlg.CheckPathExists = $true
    $dlg.ValidateNames = $false
    if ($dlg.ShowDialog() -eq $true) {
        Write-Output (Split-Path $dlg.FileName)
    }
  `;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', psScript]);
  let output = '';
  
  child.stdout.on('data', (data) => {
    output += data.toString();
  });
  
  child.on('close', (code) => {
    const p = output.trim();
    res.json({ path: p || null });
  });
});

// ── SSE 執行端點 ───────────────────────────────────────────────────────────
// 接收 POST body，以 SSE 方式串流 log 給前端，最後送出 summary 事件
app.post('/api/run', async (req, res) => {
  const { projectDirs, branch, remote, commit, isDryRun, concurrency: rawConcurrency } = req.body;

  // 基本驗證
  if (!Array.isArray(projectDirs) || !projectDirs.length || !branch || !remote || !commit) {
    return res.status(400).json({ error: '缺少必要參數' });
  }

  // 去重防護：避免相同目錄並發操作造成 Git lock 競爭
  const uniqueDirs = Array.from(new Set(projectDirs.map(d => path.normalize(d.trim()))));
  const concurrency = Math.max(1, Math.min(Number(rawConcurrency) || 3, 10));

  // 設定 SSE header
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  /** 傳送 SSE 事件 */
  const send = (eventName, data) => {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 建立 emitter 供 cherryPickFlow 傳遞 log
  const emitter = new EventEmitter();
  emitter.on('log', (entry) => send('log', entry));

  const results = [];
  const queue = [...uniqueDirs];

  // Worker 函式：從佇列持續取出專案執行
  const worker = async () => {
    while (queue.length > 0) {
      const dir = queue.shift();
      send('project-start', { dir });

      let flowResult;
      try {
        flowResult = await runCherryPickFlow({
          projectDir: dir,
          branch,
          remote,
          commit,
          isDryRun: isDryRun === true,
          emitter, // 傳入 emitter，讓 flow 推送即時 log
        });
      } catch (err) {
        flowResult = {
          status: STATUS.FAILED,
          reason: `未預期錯誤：${err.message}`,
        };
      }

      results.push({ dir, ...flowResult });
      send('project-done', { dir, ...flowResult });
    }
  };

  // 依並發數啟動 Workers
  const workerCount = Math.min(concurrency, uniqueDirs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // 全部執行完成，送出摘要
  const summary = {
    total:      results.length,
    successful: results.filter((r) => r.status === STATUS.SUCCESS).map((r) => r.dir),
    skipped:    results.filter((r) => r.status === STATUS.SKIPPED).map((r) => ({ dir: r.dir, reason: r.reason })),
    failed:     results.filter((r) => r.status === STATUS.FAILED).map((r) => ({ dir: r.dir, reason: r.reason })),
  };

  send('summary', summary);
  res.write('event: done\ndata: {}\n\n');
  res.end();
});

// ── 啟動 ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  🍒 Git AutoPick Web UI`);
  console.log(`  👉  http://localhost:${PORT}\n`);
});
