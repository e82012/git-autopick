/**
 * gitRunner.js
 * Git 命令執行核心模組
 * - 使用 child_process.spawn 執行 git 命令（shell: false）
 * - 精確捕捉 exit code（主要判斷依據）與 stderr（錯誤訊息）
 * - runGit：變更型指令，支援 dry-run 模式（僅輸出命令，不實際執行）
 * - queryGit：唯讀查詢，不受 dry-run 影響，一律實際執行
 *
 * 安全約束：
 *   本模組不提供任何強制推送能力。--force / --force-with-lease / -f
 *   不得出現於任何呼叫端，覆寫遠端歷史的後果不可回復。
 */

import { spawn } from 'child_process';
import chalk from 'chalk';

/**
 * 預設高風險分支名單
 * 語意為「推上去就收不回來」，而非「伺服器會擋」——後者 push 失敗即完整回復，
 * 前者撤銷需要強制推送，屬全域禁止項，因此才需要事前確認。
 */
export const DEFAULT_PROTECTED_BRANCHES = [
  'main', 'master', 'develop', 'dev', 'release/*',
  'production', 'prod', 'uat', 'stg', 'staging',
];

// ── git 執行檔路徑解析 ──────────────────────────────────────────────────────

/** 快取的 git 路徑解析結果（module 層級，兩個入口共用） */
let gitPathPromise = null;

/**
 * 以 shell: false 探測 git 是否可直接 spawn，失敗則解析絕對路徑後快取。
 * 讓環境差異在首次執行時暴露，而非批次跑到一半才失敗。
 * @returns {Promise<string>} 可用於 spawn 的 git 執行檔路徑
 */
function detectGitPath() {
  return new Promise((resolve) => {
    const probe = spawn('git', ['--version'], { stdio: 'ignore', shell: false });

    probe.on('close', (code) => resolve(code === 0 ? 'git' : fallbackGitPath()));
    probe.on('error', () => resolve(fallbackGitPath()));
  });
}

/**
 * 後備方案：以系統指令解析 git 絕對路徑
 * 此處使用 shell 僅為執行固定字面量命令，不含任何使用者輸入
 * @returns {Promise<string>}
 */
function fallbackGitPath() {
  const locator = process.platform === 'win32' ? 'where git' : 'which git';

  return new Promise((resolve) => {
    const proc = spawn(locator, { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
    let out = '';

    proc.stdout.on('data', (chunk) => { out += chunk.toString(); });
    proc.on('close', () => {
      // where 可能回傳多行，取第一個有效路徑
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first || 'git');
    });
    proc.on('error', () => resolve('git'));
  });
}

/** 取得（並快取）git 執行檔路徑 */
function getGitPath() {
  if (!gitPathPromise) gitPathPromise = detectGitPath();
  return gitPathPromise;
}

// ── 命令執行 ────────────────────────────────────────────────────────────────

/**
 * 實際 spawn git 並捕捉輸出（內部共用）
 * @param {string[]} args
 * @param {string}   cwd
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
async function spawnGit(args, cwd) {
  const gitPath = await getGitPath();

  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];

    // shell: false —— 參數以陣列傳遞，含空白或 & | ^ 的值不會被 cmd.exe 解譯
    const proc = spawn(gitPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));

    proc.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: stdoutChunks.join('').trim(),
        stderr: stderrChunks.join('').trim(),
      });
    });

    proc.on('error', (err) => {
      resolve({ exitCode: 1, stdout: '', stderr: `spawn error: ${err.message}` });
    });
  });
}

/**
 * 執行變更型 git 命令（dry-run 時僅顯示不執行）
 * @param {string[]} args     - git 子命令與參數，例如 ['pull', 'origin', 'main']
 * @param {string}   cwd      - 執行目錄（專案路徑）
 * @param {boolean}  isDryRun - 是否為模擬模式
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export function runGit(args, cwd, isDryRun = false) {
  if (isDryRun) {
    console.log(chalk.gray(`  [DRY-RUN] git ${args.join(' ')}`));
    return Promise.resolve({ exitCode: 0, stdout: '[dry-run]', stderr: '' });
  }
  return spawnGit(args, cwd);
}

/**
 * 執行唯讀查詢型 git 命令
 *
 * 刻意不接受 isDryRun：查詢無副作用，模擬模式下若偽造成功會使流程分流失準，
 * 預覽結果將與實際執行不符（例如分支存在判定恆為真）。
 *
 * @param {string[]} args
 * @param {string}   cwd
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export function queryGit(args, cwd) {
  return spawnGit(args, cwd);
}

// ── 狀態查詢 ────────────────────────────────────────────────────────────────

/**
 * 查詢分支於本地與遠端的存在狀態
 *
 * 回傳兩個獨立布林而非單一值：四種組合的就位方式不同，
 * 合併判定會使「本地有、遠端無」誤走 pull 路徑而失敗。
 *
 * @param {string} branch
 * @param {string} cwd
 * @param {string} pushRemote
 * @returns {Promise<{ local: boolean, remote: boolean }>}
 */
export async function branchExists(branch, cwd, pushRemote = 'origin') {
  const [localRes, remoteRes] = await Promise.all([
    queryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd),
    queryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${pushRemote}/${branch}`], cwd),
  ]);

  return {
    local:  localRes.exitCode === 0,
    remote: remoteRes.exitCode === 0,
  };
}

/**
 * 取得目前所在分支
 * detached HEAD 時 --abbrev-ref 會回傳字面量 'HEAD'，此時改回傳 commit SHA，
 * 讓呼叫端得以用 checkout <sha> 精確還原原狀態。
 *
 * @param {string} cwd
 * @returns {Promise<{ name: string, isDetached: boolean } | null>}
 */
export async function getCurrentBranch(cwd) {
  const res = await queryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (res.exitCode !== 0) return null;

  if (res.stdout === 'HEAD') {
    const shaRes = await queryGit(['rev-parse', 'HEAD'], cwd);
    if (shaRes.exitCode !== 0) return null;
    return { name: shaRes.stdout, isDetached: true };
  }

  return { name: res.stdout, isDetached: false };
}

/**
 * 判斷工作目錄是否乾淨（無未提交變更，含未追蹤檔案）
 * @param {string} cwd
 * @returns {Promise<{ clean: boolean, detail: string }>}
 */
export async function isWorkingTreeClean(cwd) {
  const res = await queryGit(['status', '--porcelain'], cwd);
  if (res.exitCode !== 0) {
    return { clean: false, detail: res.stderr || '無法讀取工作目錄狀態' };
  }
  return { clean: res.stdout === '', detail: res.stdout };
}

/**
 * 讀取指定 commit 的訊息標題（第一行）
 * 須於 git fetch <remote> 之後呼叫，否則物件尚未取得
 * @param {string} commit
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getCommitTitle(commit, cwd) {
  const res = await queryGit(['log', '-1', '--format=%s', commit], cwd);
  return res.exitCode === 0 && res.stdout ? res.stdout : null;
}

/**
 * 取得 remote 的 URL
 * @param {string} remote
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getRemoteUrl(remote, cwd) {
  const res = await queryGit(['remote', 'get-url', remote], cwd);
  return res.exitCode === 0 && res.stdout ? res.stdout : null;
}

/**
 * 取得 HEAD 的 commit SHA
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getHeadSha(cwd) {
  const res = await queryGit(['rev-parse', 'HEAD'], cwd);
  return res.exitCode === 0 && res.stdout ? res.stdout : null;
}

// ── 判定與解析 ──────────────────────────────────────────────────────────────

/**
 * 判斷分支是否命中高風險名單
 * 支援完全相等與 glob 前綴（release/*）兩種比對形式
 *
 * @param {string}   branch
 * @param {string[]} [patterns] - 未提供時採預設名單
 * @returns {boolean}
 */
export function isProtectedBranch(branch, patterns = DEFAULT_PROTECTED_BRANCHES) {
  const target = String(branch || '').trim();
  if (!target) return false;

  return patterns.some((pattern) => {
    if (!pattern.includes('*')) return pattern === target;

    // glob 轉正則：先跳脫所有正則保留字元，再將 \* 還原為 .*
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(target);
  });
}

/**
 * 自 remote URL 解析 GitHub 的 owner/repo
 * 支援 https://github.com/owner/repo(.git) 與 git@github.com:owner/repo(.git)
 *
 * @param {string} remoteUrl
 * @returns {{ owner: string, repo: string } | null} 非 GitHub 或無法解析時回傳 null
 */
export function parseOwnerRepo(remoteUrl) {
  if (!remoteUrl) return null;

  const url = remoteUrl.trim().replace(/\.git$/, '');
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/i,  // https（含帶帳號形式）
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i,             // ssh 協定形式
    /^git@github\.com:([^/]+)\/([^/]+)$/i,                      // scp-like 形式
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}

/**
 * 淨化要作為命令列參數傳遞的自由文字（PR 標題等）
 * 移除換行與控制字元、壓縮空白、限制長度
 *
 * @param {string} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function sanitizeArgValue(value, maxLength = 255) {
  if (!value) return '';

  // eslint-disable-next-line no-control-regex
  const cleaned = String(value).replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

/**
 * 判斷 cherry-pick 結果是否為「commit 已存在」（應 skip 而非失敗）
 * @param {string} stdout
 * @param {string} stderr
 * @returns {boolean}
 */
export function isAlreadyPicked(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes('nothing to commit') ||
    combined.includes('nothing added to commit') ||
    combined.includes('the previous cherry-pick is now empty') ||
    combined.includes('allow-empty')
  );
}
