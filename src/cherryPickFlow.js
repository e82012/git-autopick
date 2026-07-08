/**
 * cherryPickFlow.js
 * 單一專案的完整 cherry-pick 流程模組
 *
 * 流程：
 *   1. git pull origin {branch}     → 失敗 → rollback（無需 abort，直接記錄）
 *   2. git fetch {remote}           → 失敗 → rollback
 *   3. git cherry-pick {commit}     → 失敗（含已存在判斷）→ abort + rollback
 *   4. git push origin {branch}     → 失敗 → git reset --hard HEAD~1 rollback
 *
 * rollback 策略：
 *   - pull/fetch 失敗：無副作用，直接記錄錯誤即視為 rollback 完成
 *   - cherry-pick 失敗：執行 git cherry-pick --abort 清理衝突狀態
 *   - push 失敗：執行 git reset --hard HEAD~1 還原 commit
 */

import chalk from 'chalk';
import { runGit, isAlreadyPicked } from './gitRunner.js';

/** 結果狀態常數 */
export const STATUS = {
  SUCCESS: 'success',
  SKIPPED: 'skipped',
  FAILED:  'failed',
};

/** 簡單去除 ANSI 色彩碼（供 Web UI 純文字顯示使用） */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/**
 * 對單一專案執行完整 cherry-pick 流程
 *
 * @param {object}       params
 * @param {string}       params.projectDir   - 專案目錄絕對路徑
 * @param {string}       params.branch       - 目標分支（pull & push 使用）
 * @param {string}       params.remote       - fetch 使用的 remote 名稱
 * @param {string}       params.commit       - cherry-pick 的 commit hash
 * @param {boolean}      params.isDryRun     - 是否為模擬模式
 * @param {import('events').EventEmitter} [params.emitter] - 可選，傳入時透過 'log' 事件即時推送 log
 * @returns {Promise<{ status: string, reason: string|null }>}
 */
export async function runCherryPickFlow({ projectDir, branch, remote, commit, isDryRun, emitter }) {
  const label = chalk.cyan(`[${projectDir}]`);

  /**
   * 輸出 log：同時寫入 console 與 emitter（若存在）
   * @param {string} text  - chalk 格式的顯示文字（CLI 用）
   * @param {'info'|'success'|'warn'|'error'|'rollback'} [level]
   * @param {string} [plain] - 純文字版本（Web UI 用，省略時自動去 ANSI）
   */
  const log = (text, level = 'info', plain) => {
    console.log(`  ${label} ${text}`);
    if (emitter) {
      emitter.emit('log', {
        dir: projectDir,
        level,
        message: plain ?? stripAnsi(text),
      });
    }
  };

  // ── Step 1: git pull origin {branch} ─────────────────────────────────────
  log(chalk.gray(`git pull origin ${branch}`), 'info', `git pull origin ${branch}`);
  const pullResult = await runGit(['pull', 'origin', branch], projectDir, isDryRun);

  if (pullResult.exitCode !== 0) {
    const reason = buildReason('git pull 失敗', pullResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    // pull 失敗無副作用，無需 abort，直接回傳失敗
    return { status: STATUS.FAILED, reason };
  }
  log(chalk.green('✓ pull 成功'), 'success', '✓ pull 成功');

  // ── Step 2: git fetch {remote} ───────────────────────────────────────────
  log(chalk.gray(`git fetch ${remote}`), 'info', `git fetch ${remote}`);
  const fetchResult = await runGit(['fetch', remote], projectDir, isDryRun);

  if (fetchResult.exitCode !== 0) {
    const reason = buildReason(`git fetch ${remote} 失敗`, fetchResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    // fetch 失敗無副作用，無需 abort
    return { status: STATUS.FAILED, reason };
  }
  log(chalk.green('✓ fetch 成功'), 'success', '✓ fetch 成功');

  // ── Step 3: git cherry-pick {commit} ─────────────────────────────────────
  log(chalk.gray(`git cherry-pick ${commit}`), 'info', `git cherry-pick ${commit}`);
  const pickResult = await runGit(['cherry-pick', commit], projectDir, isDryRun);

  if (pickResult.exitCode !== 0) {
    // 判斷是否為「已存在」
    if (isAlreadyPicked(pickResult.stdout, pickResult.stderr)) {
      log(chalk.yellow('⏭  Commit 已存在，跳過'), 'warn', '⏭  Commit 已存在，跳過');
      // 清理可能的空 cherry-pick 狀態
      await abortCherryPick(projectDir, isDryRun);
      return { status: STATUS.SKIPPED, reason: 'commit 已存在於此分支' };
    }

    // 其他失敗：rollback（abort cherry-pick）
    const reason = buildReason('cherry-pick 失敗', pickResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    log(chalk.gray('→ rollback: git cherry-pick --abort'), 'rollback', '→ rollback: git cherry-pick --abort');
    await abortCherryPick(projectDir, isDryRun);
    return { status: STATUS.FAILED, reason };
  }
  log(chalk.green('✓ cherry-pick 成功'), 'success', '✓ cherry-pick 成功');

  // ── Step 4: git push origin {branch} ─────────────────────────────────────
  log(chalk.gray(`git push origin ${branch}`), 'info', `git push origin ${branch}`);
  const pushResult = await runGit(['push', 'origin', branch], projectDir, isDryRun);

  if (pushResult.exitCode !== 0) {
    const reason = buildReason('git push 失敗', pushResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    // cherry-pick 已完成（working tree clean），需 reset 還原
    log(chalk.gray('→ rollback: git reset --hard HEAD~1'), 'rollback', '→ rollback: git reset --hard HEAD~1');
    await rollbackCommit(projectDir, isDryRun, log);
    return { status: STATUS.FAILED, reason };
  }
  log(chalk.green('✓ push 成功'), 'success', '✓ push 成功');

  return { status: STATUS.SUCCESS, reason: null };
}

// ── 內部輔助函式 ─────────────────────────────────────────────────────────────

/**
 * 組合錯誤原因字串（優先取 stderr，次之 stdout，限制到第一行避免過長）
 */
function buildReason(prefix, result) {
  const detail = (result.stderr || result.stdout || '未知錯誤').split('\n')[0].trim();
  return `${prefix}：${detail}`;
}

/**
 * 執行 git cherry-pick --abort（清理衝突狀態）
 * 若 abort 本身也失敗（例如沒有進行中的 cherry-pick），視為正常，靜默處理
 */
async function abortCherryPick(cwd, isDryRun) {
  await runGit(['cherry-pick', '--abort'], cwd, isDryRun);
  // abort 失敗（沒有進行中的 cherry-pick）是預期行為，靜默忽略
}

/**
 * push 失敗後 rollback：使用 git reset --hard HEAD~1 還原最後一個 commit
 * @param {Function} log - log 輸出函式（供警告輸出）
 */
async function rollbackCommit(cwd, isDryRun, log) {
  const result = await runGit(['reset', '--hard', 'HEAD~1'], cwd, isDryRun);
  if (result.exitCode !== 0) {
    const warnMsg = `⚠ rollback 失敗，請手動還原：git reset --hard HEAD~1（目錄：${cwd}）`;
    console.log(chalk.red(`  ${warnMsg}`));
    if (log) log(chalk.red(warnMsg), 'error', warnMsg);
  }
}
