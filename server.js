/**
 * server.js — Git AutoPick Web Server
 *
 * 提供：
 *  - 靜態檔案服務（web/ 目錄）
 *  - POST /api/run          → 接收參數，執行 cherry-pick，透過 SSE 串流回傳 log
 *  - GET  /api/capabilities → 回報 gh CLI 可用性，供前端顯示生效中的 PR 軌道
 *  - GET  /api/ping         → 健康檢查
 */

import express from 'express';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCherryPickFlow, STATUS } from './src/cherryPickFlow.js';
import { isProtectedBranch, DEFAULT_PROTECTED_BRANCHES } from './src/gitRunner.js';
import { detectGhCli } from './src/prProvider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3131;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// ── 健康檢查 ──────────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => res.json({ ok: true }));

// ── 能力查詢 ──────────────────────────────────────────────────────────────
// 前端據此顯示「將自動建立 PR」或「將產生開單連結」，使用者不需自行判斷
app.get('/api/capabilities', async (_req, res) => {
  const gh = await detectGhCli();
  res.json({
    ghAvailable:     gh.available,
    ghAuthenticated: gh.authenticated,
    ghReason:        gh.reason,
    protectedBranches: DEFAULT_PROTECTED_BRANCHES,
  });
});

// ── 目錄瀏覽端點 ──────────────────────────────────────────────────────────
// 取代原生彈窗：由 server 列舉檔案系統，前端以瀏覽器內 modal 呈現。
// 之所以走後端，是因為瀏覽器沙箱拿不到資料夾的絕對路徑，而本工具需要
// 絕對路徑作為 git 的 cwd。純 localhost、操作使用者自己的機器，無額外對外暴露。
const IS_WIN = process.platform === 'win32';

/** 列舉 Windows 磁碟機（探測 A~Z 是否存在） */
function listDrives() {
  if (!IS_WIN) return ['/'];
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    try { if (fs.existsSync(d)) drives.push(d); } catch { /* 略過無法存取的磁碟 */ }
  }
  return drives;
}

/** 判斷資料夾是否為 git repo（.git 可能是目錄，submodule 情況下為檔案） */
function isGitRepo(dir) {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

/** 由絕對路徑組出麵包屑片段（根 → 各層） */
function buildSegments(target) {
  const root = path.parse(target).root;          // 例：D:\
  const rest = target.slice(root.length).split(path.sep).filter(Boolean);
  const segments = [{ name: root, path: root }];
  let acc = root;
  for (const part of rest) {
    acc = path.join(acc, part);
    segments.push({ name: part, path: acc });
  }
  return segments;
}

app.get('/api/fs', (req, res) => {
  const raw = String(req.query.path || '').trim();

  // roots 視圖：未指定路徑時，Windows 回磁碟機清單作為起點
  if (!raw && IS_WIN) {
    const drives = listDrives();
    return res.json({
      path: null, isRoot: true, parent: null, atDriveRoot: false,
      segments: [], drives,
      entries: drives.map((d) => ({ name: d, path: d, isGit: false })),
      currentIsGit: false,
    });
  }

  let target;
  try {
    target = path.resolve(raw || '/');
  } catch {
    return res.status(400).json({ error: '路徑無效' });
  }

  let dirents;
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `無法讀取目錄（${err.code || err.message}）` });
  }

  const entries = dirents
    .filter((d) => { try { return d.isDirectory(); } catch { return false; } })
    .map((d) => {
      const full = path.join(target, d.name);
      return { name: d.name, path: full, isGit: isGitRepo(full) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant', { sensitivity: 'base' }));

  const atDriveRoot = target === path.parse(target).root;
  // parent 為 null 代表上一層是磁碟機清單（僅 Windows 於磁碟根時成立）
  const parent = atDriveRoot ? (IS_WIN ? null : null) : path.dirname(target);

  res.json({
    path: target,
    isRoot: false,
    parent,
    atDriveRoot,
    segments: buildSegments(target),
    drives: listDrives(),
    entries,
    currentIsGit: isGitRepo(target),
  });
});

// ── SSE 執行端點 ───────────────────────────────────────────────────────────
// 接收 POST body，以 SSE 方式串流 log 給前端，最後送出 summary 事件
app.post('/api/run', async (req, res) => {
  const {
    projectDirs, branch, remote, commit, isDryRun,
    concurrency: rawConcurrency,
    isPrMode = false,
    isUpdateOnly = false,
    targetBranch,
    prTitle,
    pushRemote = 'origin',
    confirmProtectedPush = false,
    autoMerge = false,
    mergeMethod = 'squash',
    deleteBranchOnMerge = true,
  } = req.body;

  // ── 基本驗證 ────────────────────────────────────────────────────────────
  // 僅更新分支模式不做 cherry-pick，commit 非必填；其餘模式維持必填
  const commitRequired = isUpdateOnly !== true;
  if (!Array.isArray(projectDirs) || !projectDirs.length || !branch || !remote || (commitRequired && !commit)) {
    return res.status(400).json({ error: '缺少必要參數' });
  }

  // 僅更新分支與 PR 模式互斥：兩者流程完全不同，不允許同時啟用
  if (isUpdateOnly === true && isPrMode === true) {
    return res.status(400).json({ error: '「僅更新分支」與「PR 模式」不可同時啟用' });
  }

  // PR 模式下基準分支為必填，否則無從決定新分支的切出點與 PR 合併目標
  if (isPrMode === true && !targetBranch) {
    return res.status(400).json({ error: 'PR 模式需要指定合併目標分支' });
  }

  // 合併方式限定為 gh 支援的三種，避免任意值被組進命令列參數
  const MERGE_METHODS = ['squash', 'merge', 'rebase'];
  if (autoMerge === true && !MERGE_METHODS.includes(mergeMethod)) {
    return res.status(400).json({ error: `合併方式須為 ${MERGE_METHODS.join(' / ')} 其中之一` });
  }

  // ── 高風險分支閘門 ──────────────────────────────────────────────────────
  // 防的是「推得上去、但撤銷需要強制推送」的情境；被伺服器擋下的推送
  // 屬 push 失敗路徑，已有完整回復機制，不需要事前攔截。
  // 僅更新分支模式全程不 push，主線分支拉最新是常態操作，不套用此閘門。
  if (isUpdateOnly !== true && isProtectedBranch(branch)) {
    if (isPrMode === true) {
      return res.status(400).json({
        error: `PR 模式的工作分支不可為主線分支「${branch}」，請改用功能分支名稱`,
        code: 'PROTECTED_BRANCH_PR',
        branch,
      });
    }
    if (confirmProtectedPush !== true) {
      return res.status(400).json({
        error: `「${branch}」屬高風險分支，直接推送後僅能以 git revert 退回，請先確認`,
        code: 'PROTECTED_BRANCH_CONFIRM',
        branch,
        dirs: projectDirs,
      });
    }
  }

  // 去重防護：避免相同目錄並發操作造成 Git lock 競爭
  const uniqueDirs = Array.from(new Set(projectDirs.map((d) => path.normalize(d.trim()))));
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
          emitter,
          isPrMode: isPrMode === true,
          isUpdateOnly: isUpdateOnly === true,
          targetBranch,
          prTitle,
          pushRemote,
          autoMerge: autoMerge === true,
          mergeMethod,
          deleteBranchOnMerge: deleteBranchOnMerge !== false,
        });
      } catch (err) {
        flowResult = {
          status: STATUS.FAILED,
          reason: `未預期錯誤：${err.message}`,
          prUrl: null,
          prCreated: false,
          prError: null,
          merged: false,
          mergeError: null,
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
    successful: results
      .filter((r) => r.status === STATUS.SUCCESS)
      .map((r) => ({
        dir: r.dir, prUrl: r.prUrl, prCreated: r.prCreated, prError: r.prError,
        merged: r.merged, mergeError: r.mergeError,
      })),
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
