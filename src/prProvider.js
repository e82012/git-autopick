/**
 * prProvider.js
 * PR 建立抽象層（目前實作：GitHub）
 *
 * 雙軌設計：
 *   軌道一（零依賴，永遠可用）
 *     push 後產生預填的開單連結，不自動建立 PR。
 *     連結來源：解析 push 輸出 → 失敗則以 remote URL 組裝 compare 連結。
 *
 *   軌道二（偵測到 gh CLI 且已登入才啟用）
 *     以 gh pr create 實際建立 PR；PR 已存在時改以 gh pr view 取回既有網址。
 *
 * 流程層只呼叫 createPullRequest，不感知平台差異——日後新增 GitLab
 * 實作時不需改動 cherryPickFlow。
 */

import { spawn } from 'child_process';
import { getRemoteUrl, parseOwnerRepo, sanitizeArgValue } from './gitRunner.js';

/** gh 可用性偵測結果快取 */
let ghCapabilityPromise = null;

// ── gh CLI 執行 ─────────────────────────────────────────────────────────────

/**
 * 執行 gh 命令（shell: false，參數以陣列傳遞）
 * @param {string[]} args
 * @param {string}   [cwd]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function runGh(args, cwd) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];

    const proc = spawn('gh', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      // 明確關閉互動提示：非 TTY 下 gh 本就不會提示，此處為版本差異的保險
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
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
 * 偵測 gh CLI 是否安裝且已完成登入（結果快取）
 * @returns {Promise<{ available: boolean, authenticated: boolean, reason: string|null }>}
 */
export function detectGhCli() {
  if (ghCapabilityPromise) return ghCapabilityPromise;

  ghCapabilityPromise = (async () => {
    const version = await runGh(['--version']);
    if (version.exitCode !== 0) {
      return { available: false, authenticated: false, reason: '未偵測到 gh CLI' };
    }

    const auth = await runGh(['auth', 'status']);
    if (auth.exitCode !== 0) {
      return { available: true, authenticated: false, reason: 'gh CLI 尚未登入（請執行 gh auth login）' };
    }

    return { available: true, authenticated: true, reason: null };
  })();

  return ghCapabilityPromise;
}

/** 重設偵測快取（供測試使用） */
export function resetGhCache() {
  ghCapabilityPromise = null;
}

// ── 連結組裝與解析 ──────────────────────────────────────────────────────────

/**
 * 編碼 URL 片段，但保留分支名稱中的斜線（feat/foo 需維持可讀且 GitHub 可解析）
 * @param {string} segment
 * @returns {string}
 */
function encodeRef(segment) {
  return encodeURIComponent(segment).replace(/%2F/gi, '/');
}

/**
 * 組裝 GitHub compare 開單連結（確定性，不依賴任何輸出格式）
 *
 * 工作分支已有開啟中的 PR 時 GitHub 不會印出提示連結，
 * 此組裝結果即為該情境下的主要來源，並非僅是備援。
 *
 * @param {{ owner: string, repo: string, targetBranch: string, branch: string }} params
 * @returns {string}
 */
export function buildComparePrUrl({ owner, repo, targetBranch, branch }) {
  return `https://github.com/${encodeRef(owner)}/${encodeRef(repo)}` +
         `/compare/${encodeRef(targetBranch)}...${encodeRef(branch)}?expand=1`;
}

/**
 * 自 git push 輸出解析 PR 連結
 *
 * 以 URL 特徵比對（路徑含 /pull/ 或 /compare/），不依賴
 * 「Create a pull request for ...」這類提示文案——文案隨版本與語系變動。
 * GitHub 的 remote 訊息走 stderr，故兩個串流都掃描。
 *
 * @param {string} stdout
 * @param {string} stderr
 * @returns {string|null}
 */
export function parsePrUrl(stdout, stderr) {
  const combined = `${stdout || ''}\n${stderr || ''}`;
  const matches = combined.match(/https:\/\/[^\s'"]+/g);
  if (!matches) return null;

  const hit = matches.find((url) => url.includes('/pull/') || url.includes('/compare/'));
  // 去除輸出換行可能帶入的結尾標點
  return hit ? hit.replace(/[.,;)\]]+$/, '') : null;
}

// ── 主要介面 ────────────────────────────────────────────────────────────────

/**
 * 建立 PR（或在無法建立時提供開單連結）
 *
 * 本函式不會失敗中止流程：任何錯誤都轉為 error 欄位回傳，
 * 由呼叫端依清理規約 C 處理（推送已成功，不因 PR 未建立而回滾）。
 *
 * @param {object} params
 * @param {string} params.cwd
 * @param {string} params.pushRemote
 * @param {string} params.branch        - 工作分支
 * @param {string} params.targetBranch  - PR 合併目標分支
 * @param {string} params.title
 * @param {string} [params.body]
 * @param {string} [params.pushStdout]  - push 的輸出，供解析既有連結
 * @param {string} [params.pushStderr]
 * @param {boolean}[params.isDryRun]
 * @returns {Promise<{ url: string|null, created: boolean, error: string|null }>}
 */
export async function createPullRequest({
  cwd, pushRemote, branch, targetBranch, title, body,
  pushStdout = '', pushStderr = '', isDryRun = false,
}) {
  // 1. 解析 remote，取得 owner/repo（兩條軌道皆需要）
  const remoteUrl = await getRemoteUrl(pushRemote, cwd);
  const ownerRepo = parseOwnerRepo(remoteUrl);

  if (!ownerRepo) {
    // 仍嘗試自 push 輸出撈連結：非 GitHub 平台也可能印出可用網址
    const parsed = parsePrUrl(pushStdout, pushStderr);
    return {
      url: parsed,
      created: false,
      error: parsed ? null : `無法自 remote「${pushRemote}」解析 GitHub 專案（${remoteUrl || '取不到 URL'}）`,
    };
  }

  const compareUrl = buildComparePrUrl({ ...ownerRepo, targetBranch, branch });

  // 2. dry-run：不呼叫 gh，回傳可預覽的開單連結
  if (isDryRun) {
    return { url: compareUrl, created: false, error: null };
  }

  // 3. 軌道二：gh 可用且已登入時實際建立 PR
  const gh = await detectGhCli();
  if (gh.available && gh.authenticated) {
    const result = await createViaGh({ cwd, ownerRepo, branch, targetBranch, title, body });
    if (result.url) return result;

    // gh 失敗 → 退回軌道一，並保留失敗原因
    return {
      url: parsePrUrl(pushStdout, pushStderr) || compareUrl,
      created: false,
      error: result.error,
    };
  }

  // 4. 軌道一：解析 push 輸出優先，取不到則用確定性組裝的 compare 連結
  return {
    url: parsePrUrl(pushStdout, pushStderr) || compareUrl,
    created: false,
    error: null,
  };
}

/**
 * 合併 PR
 *
 * 適用情境：主線分支僅禁止直推、不要求審核核准——PR 是流程要求而非審查關卡。
 * 此路徑不涉及 approve（GitHub 禁止核准自己的 PR，該限制在 API 層級亦成立），
 * 僅需具備合併權限即可完成。
 *
 * 呼叫前必須已切離工作分支：--delete-branch 會一併刪除本地分支，
 * 停留在該分支上會使刪除失敗。
 *
 * @param {object}  params
 * @param {string}  params.cwd
 * @param {string}  params.pushRemote
 * @param {string}  params.branch
 * @param {'squash'|'merge'|'rebase'} [params.method]
 * @param {boolean} [params.deleteBranch]
 * @param {boolean} [params.isDryRun]
 * @returns {Promise<{ merged: boolean, error: string|null }>}
 */
export async function mergePullRequest({
  cwd, pushRemote, branch, method = 'squash', deleteBranch = true, isDryRun = false,
}) {
  if (isDryRun) {
    return { merged: false, error: null };
  }

  const gh = await detectGhCli();
  if (!gh.available || !gh.authenticated) {
    return { merged: false, error: `自動合併需要 gh CLI：${gh.reason}` };
  }

  const ownerRepo = parseOwnerRepo(await getRemoteUrl(pushRemote, cwd));
  if (!ownerRepo) {
    return { merged: false, error: `無法自 remote「${pushRemote}」解析 GitHub 專案` };
  }

  const args = [
    'pr', 'merge', branch,
    '--repo', `${ownerRepo.owner}/${ownerRepo.repo}`,
    `--${method}`,
  ];
  if (deleteBranch) args.push('--delete-branch');

  const res = await runGh(args, cwd);
  if (res.exitCode === 0) return { merged: true, error: null };

  return { merged: false, error: explainMergeFailure(res) };
}

/**
 * 將 gh 的合併失敗訊息轉為可行動的說明
 * 合併失敗的原因多半是設定而非指令錯誤，直接回傳原始訊息不利於判斷下一步
 */
function explainMergeFailure(res) {
  const raw = (res.stderr || res.stdout || '未知錯誤').trim();
  const lower = raw.toLowerCase();

  if (lower.includes('approv')) {
    return `該分支的保護規則要求審核核准，無法自動合併（GitHub 不允許核准自己的 PR）：${firstLine(raw)}`;
  }
  if (lower.includes('check') && (lower.includes('pending') || lower.includes('required') || lower.includes('fail'))) {
    return `必要的狀態檢查尚未通過，無法立即合併：${firstLine(raw)}`;
  }
  if (lower.includes('conflict') || lower.includes('not mergeable')) {
    return `與目標分支有衝突，需人工處理：${firstLine(raw)}`;
  }
  if (lower.includes('403') || lower.includes('not accessible') || lower.includes('permission')) {
    return `權限不足，目前帳號無法合併此 PR：${firstLine(raw)}`;
  }
  return `gh pr merge 失敗：${firstLine(raw)}`;
}

function firstLine(text) {
  return text.split('\n')[0].trim();
}

/**
 * 以 gh CLI 建立 PR；已存在時取回既有 PR 網址
 * @returns {Promise<{ url: string|null, created: boolean, error: string|null }>}
 */
async function createViaGh({ cwd, ownerRepo, branch, targetBranch, title, body }) {
  const repoFlag = `${ownerRepo.owner}/${ownerRepo.repo}`;

  // --repo 必須明確指定：多 remote 專案下 gh 的自行推斷結果不確定
  const createRes = await runGh([
    'pr', 'create',
    '--repo', repoFlag,
    '--base', targetBranch,
    '--head', branch,
    '--title', sanitizeArgValue(title) || `Cherry-pick ${branch}`,
    '--body', body || '',
  ], cwd);

  if (createRes.exitCode === 0) {
    const url = parsePrUrl(createRes.stdout, createRes.stderr);
    return { url, created: Boolean(url), error: url ? null : 'gh pr create 成功但未取得網址' };
  }

  // 建立失敗最常見的原因是 PR 已存在——改以查詢取回既有網址，
  // 使重複執行有明確定義的結果，不依賴任何未驗證的平台行為
  const viewRes = await runGh([
    'pr', 'view', branch,
    '--repo', repoFlag,
    '--json', 'url',
  ], cwd);

  if (viewRes.exitCode === 0) {
    try {
      const parsed = JSON.parse(viewRes.stdout);
      if (parsed?.url) return { url: parsed.url, created: false, error: null };
    } catch {
      // JSON 解析失敗時落到下方統一錯誤處理
    }
  }

  const detail = (createRes.stderr || createRes.stdout || '未知錯誤').split('\n')[0].trim();
  return { url: null, created: false, error: `gh pr create 失敗：${detail}` };
}
