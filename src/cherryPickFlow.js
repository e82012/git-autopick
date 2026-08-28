/**
 * cherryPickFlow.js
 * 單一專案的完整 cherry-pick 流程模組
 *
 * 三種模式：
 *   直推模式（isPrMode: false，預設）
 *     switch → pull → fetch → cherry-pick → push，維持既有行為。
 *
 *   PR 模式（isPrMode: true）
 *     fetch 基準 → 分支就位 → fetch 來源 → cherry-pick → push → 建立 PR
 *     → 切回原分支 →（選用）自動合併。
 *
 *   僅更新分支（isUpdateOnly: true）
 *     switch → pull --ff-only，把工作分支拉到最新即停止，不做 cherry-pick／push。
 *     用於「單純把某分支同步到遠端最新」的情境，全程不改動遠端。
 *
 *     自動合併適用於「主線僅禁止直推、不要求審核核准」的專案：PR 是流程要求
 *     而非審查關卡，全程不涉及 approve。
 *
 * 全域約束：
 *   任何路徑皆不得產生 --force / --force-with-lease / -f。
 *   每一條失敗路徑都有不依賴強制推送的回退方式，見下方清理規約。
 *
 * 清理規約：
 *   A（cherry-pick 失敗）：abort → 切回原分支 → 刪除臨時分支（僅限本次新建者）
 *   B（push 失敗，遠端未變更）：本地 reset 至 preCommitSha → 切回原分支
 *   C（push 成功但 PR 建立失敗）：不回退，輸出 git revert 指引
 *   D（PR 已建立但合併未成功）：不回退，保留 PR 供人工接手
 */

import chalk from 'chalk';
import * as realGitRunner from './gitRunner.js';
import * as realPrProvider from './prProvider.js';

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
 * @param {object}   params
 * @param {string}   params.projectDir     - 專案目錄絕對路徑
 * @param {string}   params.branch         - 工作分支（直推模式即推送目標分支）
 * @param {string}   params.remote         - cherry-pick 來源 remote
 * @param {string}   params.commit         - cherry-pick 的 commit hash
 * @param {boolean}  params.isDryRun       - 是否為模擬模式
 * @param {import('events').EventEmitter} [params.emitter]
 * @param {boolean}  [params.isPrMode]     - 是否啟用 PR 模式
 * @param {boolean}  [params.isUpdateOnly] - 是否啟用「僅更新分支」（switch → pull，不 cherry-pick／push）
 * @param {string}   [params.targetBranch] - PR 合併目標分支（PR 模式必填）
 * @param {string}   [params.prTitle]      - PR 標題，留空時取 commit 標題
 * @param {string}   [params.pushRemote]   - 推送 remote，預設 origin
 * @param {object}   [params.gitRunner]    - 測試注入接縫
 * @param {object}   [params.prProvider]   - 測試注入接縫
 * @returns {Promise<{ status: string, reason: string|null, prUrl: string|null, prCreated: boolean, prError: string|null }>}
 */
export async function runCherryPickFlow({
  projectDir, branch, remote, commit, isDryRun, emitter,
  isPrMode = false,
  isUpdateOnly = false,
  targetBranch,
  prTitle,
  pushRemote = 'origin',
  autoMerge = false,
  mergeMethod = 'squash',
  deleteBranchOnMerge = true,
  gitRunner,
  prProvider,
}) {
  const git = gitRunner ?? realGitRunner;
  const pr  = prProvider ?? realPrProvider;
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
      emitter.emit('log', { dir: projectDir, level, message: plain ?? stripAnsi(text) });
    }
  };

  /** 統一的失敗結果組裝（欄位齊備，讓呼叫端不需判斷模式） */
  const fail = (reason) => ({
    status: STATUS.FAILED, reason,
    prUrl: null, prCreated: false, prError: null,
    merged: false, mergeError: null,
  });

  // ── Step -1: 前置快照與工作區檢查（兩種模式皆套用） ───────────────────────
  // 工作目錄有未提交變更時，git switch 的結果不可預期（可能挾帶變更或直接失敗），
  // 且清理規約需要「執行前在哪個分支」才有辦法還原，故必須先取得。
  const originalRef = await git.getCurrentBranch(projectDir);
  if (!originalRef) {
    const reason = '無法讀取目前分支，請確認該目錄為 git 專案';
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    return fail(reason);
  }

  const treeState = await git.isWorkingTreeClean(projectDir);
  if (!treeState.clean) {
    const firstLine = (treeState.detail || '').split('\n')[0].trim();
    const reason = `工作目錄有未提交的變更，已略過以避免非預期狀態（例：${firstLine || '不明'}）`;
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    return fail(reason);
  }
  log(
    chalk.gray(`✓ 前置檢查通過（原分支：${originalRef.name}${originalRef.isDetached ? ' [detached]' : ''}）`),
    'info',
    `✓ 前置檢查通過（原分支：${originalRef.name}${originalRef.isDetached ? ' [detached]' : ''}）`,
  );

  /** 切回執行前所在的位置 */
  const restoreOriginalRef = async () => {
    const args = originalRef.isDetached
      ? ['checkout', originalRef.name]
      : ['switch', originalRef.name];
    await git.runGit(args, projectDir, isDryRun);
  };

  if (isUpdateOnly) {
    return runUpdateOnlyMode({ git, log, fail, projectDir, branch, remote, isDryRun });
  }

  return isPrMode
    ? runPrMode({
        git, pr, log, fail, projectDir, branch, remote, commit, isDryRun,
        targetBranch, prTitle, pushRemote, originalRef, restoreOriginalRef,
        autoMerge, mergeMethod, deleteBranchOnMerge,
      })
    : runDirectMode({
        git, log, fail, projectDir, branch, remote, commit, isDryRun, pushRemote,
      });
}

// ── 僅更新分支模式 ──────────────────────────────────────────────────────────

/**
 * 僅更新分支：switch → pull --ff-only，把工作分支同步到遠端最新即停止。
 *
 * 全程不改動遠端（無 push、無建立 PR），故不需要任何清理規約：
 * pull --ff-only 在分支分岔時會直接失敗，不會產生非預期的合併提交，
 * 本地狀態維持在 pull 前，使用者自行決定如何處理分岔即可。
 *
 * 刻意不切回原分支——語意即「把這個分支拉到最新」，停留在該分支符合預期，
 * 與直推模式停留在目標分支的既有行為一致。
 */
async function runUpdateOnlyMode({ git, log, fail, projectDir, branch, remote, isDryRun }) {
  // ── Step 0: git switch {branch} ──────────────────────────────────────────
  log(chalk.gray(`git switch ${branch}`), 'info', `git switch ${branch}`);
  const switchResult = await git.runGit(['switch', branch], projectDir, isDryRun);

  if (switchResult.exitCode !== 0) {
    const reason = buildReason(`git switch ${branch} 失敗`, switchResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    return fail(reason);
  }
  log(chalk.green(`✓ 已切換至 ${branch}`), 'success', `✓ 已切換至 ${branch}`);

  // ── Step 1: git pull --ff-only {remote} {branch} ─────────────────────────
  // --ff-only：分支分岔時直接失敗，不產生非預期的合併提交（與 PR 模式同一準則）
  log(chalk.gray(`git pull --ff-only ${remote} ${branch}`), 'info', `git pull --ff-only ${remote} ${branch}`);
  const pullResult = await git.runGit(['pull', '--ff-only', remote, branch], projectDir, isDryRun);

  if (pullResult.exitCode !== 0) {
    const reason = buildReason('git pull 失敗', pullResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    return fail(reason);
  }
  log(chalk.green(`✓ ${branch} 已更新至最新`), 'success', `✓ ${branch} 已更新至最新`);

  return {
    status: STATUS.SUCCESS, reason: null,
    prUrl: null, prCreated: false, prError: null, merged: false, mergeError: null,
  };
}

// ── 直推模式 ────────────────────────────────────────────────────────────────

/**
 * 直推模式：維持既有指令序列，僅新增前置檢查
 * 刻意不在結束後切回原分支——既有行為即停留在目標分支，變更會影響現有使用習慣。
 */
async function runDirectMode({ git, log, fail, projectDir, branch, remote, commit, isDryRun, pushRemote }) {
  // ── Step 0: git switch {branch} ──────────────────────────────────────────
  log(chalk.gray(`git switch ${branch}`), 'info', `git switch ${branch}`);
  const switchResult = await git.runGit(['switch', branch], projectDir, isDryRun);

  if (switchResult.exitCode !== 0) {
    const reason = buildReason(`git switch ${branch} 失敗`, switchResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    return fail(reason);
  }
  log(chalk.green(`✓ 已切換至 ${branch}`), 'success', `✓ 已切換至 ${branch}`);

  // ── Step 1: git pull {pushRemote} {branch} ───────────────────────────────
  log(chalk.gray(`git pull ${pushRemote} ${branch}`), 'info', `git pull ${pushRemote} ${branch}`);
  const pullResult = await git.runGit(['pull', pushRemote, branch], projectDir, isDryRun);

  if (pullResult.exitCode !== 0) {
    const reason = buildReason('git pull 失敗', pullResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    return fail(reason);
  }
  log(chalk.green('✓ pull 成功'), 'success', '✓ pull 成功');

  // ── Step 2: git fetch {remote} ───────────────────────────────────────────
  log(chalk.gray(`git fetch ${remote}`), 'info', `git fetch ${remote}`);
  const fetchResult = await git.runGit(['fetch', remote], projectDir, isDryRun);

  if (fetchResult.exitCode !== 0) {
    const reason = buildReason(`git fetch ${remote} 失敗`, fetchResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    return fail(reason);
  }
  log(chalk.green('✓ fetch 成功'), 'success', '✓ fetch 成功');

  // ── Step 3: 記錄 cherry-pick 前的 HEAD，供 push 失敗時精確回退 ───────────
  const preCommitSha = await git.getHeadSha(projectDir);

  // ── Step 4: git cherry-pick {commit} ─────────────────────────────────────
  log(chalk.gray(`git cherry-pick ${commit}`), 'info', `git cherry-pick ${commit}`);
  const pickResult = await git.runGit(['cherry-pick', commit], projectDir, isDryRun);

  if (pickResult.exitCode !== 0) {
    if (git.isAlreadyPicked(pickResult.stdout, pickResult.stderr)) {
      log(chalk.yellow('⏭  Commit 已存在，跳過'), 'warn', '⏭  Commit 已存在，跳過');
      await git.runGit(['cherry-pick', '--abort'], projectDir, isDryRun);
      return {
        status: STATUS.SKIPPED, reason: 'commit 已存在於此分支',
        prUrl: null, prCreated: false, prError: null, merged: false, mergeError: null,
      };
    }

    const reason = buildReason('cherry-pick 失敗', pickResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    log(chalk.gray('→ rollback: git cherry-pick --abort'), 'rollback', '→ rollback: git cherry-pick --abort');
    await git.runGit(['cherry-pick', '--abort'], projectDir, isDryRun);
    return fail(reason);
  }
  log(chalk.green('✓ cherry-pick 成功'), 'success', '✓ cherry-pick 成功');

  // ── Step 5: git push {pushRemote} {branch} ───────────────────────────────
  log(chalk.gray(`git push ${pushRemote} ${branch}`), 'info', `git push ${pushRemote} ${branch}`);
  const pushResult = await git.runGit(['push', pushRemote, branch], projectDir, isDryRun);

  if (pushResult.exitCode !== 0) {
    const reason = buildReason('git push 失敗', pushResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    // push 失敗代表遠端未變更，本地重置即為完整回復，不涉及遠端歷史覆寫
    await rollbackToSha({ git, log, projectDir, isDryRun, preCommitSha });
    return fail(reason);
  }
  log(chalk.green('✓ push 成功'), 'success', '✓ push 成功');

  return {
    status: STATUS.SUCCESS, reason: null,
    prUrl: null, prCreated: false, prError: null, merged: false, mergeError: null,
  };
}

// ── PR 模式 ─────────────────────────────────────────────────────────────────

async function runPrMode({
  git, pr, log, fail, projectDir, branch, remote, commit, isDryRun,
  targetBranch, prTitle, pushRemote, originalRef, restoreOriginalRef,
  autoMerge, mergeMethod, deleteBranchOnMerge,
}) {
  // ── Step 1: 同步基準分支 ─────────────────────────────────────────────────
  log(chalk.gray(`git fetch ${pushRemote} ${targetBranch}`), 'info', `git fetch ${pushRemote} ${targetBranch}`);
  const fetchBase = await git.runGit(['fetch', pushRemote, targetBranch], projectDir, isDryRun);

  if (fetchBase.exitCode !== 0) {
    const reason = buildReason(`git fetch ${pushRemote} ${targetBranch} 失敗`, fetchBase);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    return fail(reason);
  }

  // ── Step 2-3: 分支就位 ───────────────────────────────────────────────────
  // 本地與遠端分開判定：四種組合的就位方式不同，合併成單一布林會使
  // 「本地有、遠端無」誤走 pull 路徑而失敗。
  const exists = await git.branchExists(branch, projectDir, pushRemote);
  const isNewlyCreated = !exists.local && !exists.remote;

  const readyResult = await checkoutWorkBranch({
    git, log, projectDir, branch, targetBranch, pushRemote, isDryRun, exists,
  });

  if (readyResult.exitCode !== 0) {
    const reason = buildReason('工作分支就位失敗', readyResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    await restoreOriginalRef();
    return fail(reason);
  }

  /** 清理規約 A：cherry-pick 失敗後的還原（順序固定，不可調換） */
  const cleanupA = async () => {
    log(chalk.gray('→ rollback: git cherry-pick --abort'), 'rollback', '→ rollback: git cherry-pick --abort');
    await git.runGit(['cherry-pick', '--abort'], projectDir, isDryRun);
    await restoreOriginalRef();
    // 僅刪除本次新建的分支——既有分支可能是他人的工作分支，誤刪無法自動回復
    if (isNewlyCreated) {
      log(chalk.gray(`→ rollback: git branch -D ${branch}`), 'rollback', `→ rollback: git branch -D ${branch}`);
      await git.runGit(['branch', '-D', branch], projectDir, isDryRun);
    }
  };

  // ── Step 4: 取得 cherry-pick 來源 ────────────────────────────────────────
  log(chalk.gray(`git fetch ${remote}`), 'info', `git fetch ${remote}`);
  const fetchSrc = await git.runGit(['fetch', remote], projectDir, isDryRun);

  if (fetchSrc.exitCode !== 0) {
    const reason = buildReason(`git fetch ${remote} 失敗`, fetchSrc);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    await restoreOriginalRef();
    if (isNewlyCreated) await git.runGit(['branch', '-D', branch], projectDir, isDryRun);
    return fail(reason);
  }

  // ── Step 5: 決定 PR 標題 ─────────────────────────────────────────────────
  let resolvedTitle = git.sanitizeArgValue(prTitle || '');
  if (!resolvedTitle) {
    const commitTitle = await git.getCommitTitle(commit, projectDir);
    if (commitTitle) {
      resolvedTitle = git.sanitizeArgValue(commitTitle);
    } else {
      // dry-run 下 fetch 未實際執行，物件可能尚未取得；明確標示為回退值
      resolvedTitle = `Cherry-pick ${String(commit).slice(0, 7)}`;
      log(
        chalk.yellow(`⚠ 無法讀取 commit 標題，PR 標題回退為「${resolvedTitle}」`),
        'warn',
        `⚠ 無法讀取 commit 標題，PR 標題回退為「${resolvedTitle}」`,
      );
    }
  }

  // ── Step 6: 記錄 cherry-pick 前的 HEAD ───────────────────────────────────
  const preCommitSha = await git.getHeadSha(projectDir);

  // ── Step 7: cherry-pick ──────────────────────────────────────────────────
  log(chalk.gray(`git cherry-pick ${commit}`), 'info', `git cherry-pick ${commit}`);
  const pickResult = await git.runGit(['cherry-pick', commit], projectDir, isDryRun);

  if (pickResult.exitCode !== 0) {
    if (git.isAlreadyPicked(pickResult.stdout, pickResult.stderr)) {
      log(chalk.yellow('⏭  Commit 已存在，跳過'), 'warn', '⏭  Commit 已存在，跳過');
      await cleanupA();
      return {
        status: STATUS.SKIPPED, reason: 'commit 已存在於此分支',
        prUrl: null, prCreated: false, prError: null, merged: false, mergeError: null,
      };
    }

    const reason = buildReason('cherry-pick 失敗', pickResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);
    await cleanupA();
    return fail(reason);
  }
  log(chalk.green('✓ cherry-pick 成功'), 'success', '✓ cherry-pick 成功');

  // ── Step 8: push（一般推送，不使用強制推送） ─────────────────────────────
  log(chalk.gray(`git push ${pushRemote} ${branch}`), 'info', `git push ${pushRemote} ${branch}`);
  const pushResult = await git.runGit(['push', pushRemote, branch], projectDir, isDryRun);

  if (pushResult.exitCode !== 0) {
    const reason = buildReason('git push 失敗', pushResult);
    log(chalk.red(`✗ ${reason}`), 'error', `✗ ${reason}`);

    // 清理規約 B：push 失敗代表遠端未變更
    if (isNewlyCreated) {
      // 分支整條丟棄即可，不需要 reset
      await restoreOriginalRef();
      log(chalk.gray(`→ rollback: git branch -D ${branch}`), 'rollback', `→ rollback: git branch -D ${branch}`);
      await git.runGit(['branch', '-D', branch], projectDir, isDryRun);
    } else {
      await rollbackToSha({ git, log, projectDir, isDryRun, preCommitSha });
      await restoreOriginalRef();
    }
    return fail(reason);
  }
  log(chalk.green('✓ push 成功'), 'success', '✓ push 成功');

  // ── Step 9: 建立 PR ──────────────────────────────────────────────────────
  const newCommitSha = await git.getHeadSha(projectDir);
  const prResult = await pr.createPullRequest({
    cwd: projectDir,
    pushRemote,
    branch,
    targetBranch,
    title: resolvedTitle,
    body: `Cherry-picked from \`${commit}\`.`,
    pushStdout: pushResult.stdout,
    pushStderr: pushResult.stderr,
    isDryRun,
  });

  if (prResult.created) {
    log(chalk.green(`✓ 已建立 PR：${prResult.url}`), 'success', `✓ 已建立 PR：${prResult.url}`);
  } else if (prResult.url) {
    log(chalk.cyan(`→ 開單連結：${prResult.url}`), 'info', `→ 開單連結：${prResult.url}`);
  }

  // 清理規約 C：推送已成功，不因 PR 未建立而回退——撤銷已推送的提交
  // 需要強制推送，屬全域禁止項。改為輸出不需強制推送的 revert 指引。
  if (prResult.error) {
    log(chalk.yellow(`⚠ PR 建立未完成：${prResult.error}`), 'warn', `⚠ PR 建立未完成：${prResult.error}`);
    if (newCommitSha) {
      const revertHint = `若需退回：git revert ${newCommitSha} && git push ${pushRemote} ${branch}`;
      log(chalk.yellow(`  ${revertHint}`), 'warn', `  ${revertHint}`);
    }
  }

  // ── Step 10: 切回原分支 ──────────────────────────────────────────────────
  // 工作分支由工具建立，不應改變使用者原本的工作狀態。
  // 此步必須排在合併之前：--delete-branch 會一併刪除本地分支，
  // 停留在該分支上會使刪除失敗。
  await restoreOriginalRef();
  log(chalk.gray(`✓ 已切回 ${originalRef.name}`), 'info', `✓ 已切回 ${originalRef.name}`);

  // ── Step 11: 自動合併（選用） ────────────────────────────────────────────
  let merged = false;
  let mergeError = null;

  if (autoMerge && prResult.created) {
    log(chalk.gray(`gh pr merge ${branch} --${mergeMethod}`), 'info', `gh pr merge ${branch} --${mergeMethod}`);
    const mergeResult = await pr.mergePullRequest({
      cwd: projectDir,
      pushRemote,
      branch,
      method: mergeMethod,
      deleteBranch: deleteBranchOnMerge,
      isDryRun,
    });

    merged = mergeResult.merged;
    mergeError = mergeResult.error;

    if (merged) {
      log(chalk.green(`✓ 已合併至 ${targetBranch}`), 'success', `✓ 已合併至 ${targetBranch}`);
    } else if (mergeError) {
      // 清理規約 D：PR 已建立、內容已推送，合併未成功不構成錯誤狀態，
      // 僅代表這一步需要人工接手。不回退任何已完成的動作。
      log(chalk.yellow(`⚠ 自動合併未完成：${mergeError}`), 'warn', `⚠ 自動合併未完成：${mergeError}`);
      log(chalk.yellow(`  PR 已建立，可自行合併：${prResult.url}`), 'warn', `  PR 已建立，可自行合併：${prResult.url}`);
    }
  } else if (autoMerge && !prResult.created) {
    mergeError = '未實際建立 PR（未偵測到 gh CLI 或建立失敗），無法自動合併';
    log(chalk.yellow(`⚠ ${mergeError}`), 'warn', `⚠ ${mergeError}`);
  }

  return {
    status: STATUS.SUCCESS,
    reason: null,
    prUrl: prResult.url,
    prCreated: prResult.created,
    prError: prResult.error,
    merged,
    mergeError,
  };
}

/**
 * 工作分支就位：依本地／遠端存在狀態四選一
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
async function checkoutWorkBranch({ git, log, projectDir, branch, targetBranch, pushRemote, isDryRun, exists }) {
  // 全新分支：自最新基準切出
  if (!exists.local && !exists.remote) {
    const cmd = `git checkout -b ${branch} ${pushRemote}/${targetBranch}`;
    log(chalk.gray(`偵測為新分支，自 ${pushRemote}/${targetBranch} 切出`), 'info', `偵測為新分支，自 ${pushRemote}/${targetBranch} 切出`);
    log(chalk.gray(cmd), 'info', cmd);
    return git.runGit(['checkout', '-b', branch, `${pushRemote}/${targetBranch}`], projectDir, isDryRun);
  }

  // 既有分支：切過去，不與基準對齊（維持該分支既有進度）
  log(chalk.gray(`切換至既有分支 ${branch}`), 'info', `切換至既有分支 ${branch}`);
  log(chalk.gray(`git switch ${branch}`), 'info', `git switch ${branch}`);
  const switchResult = await git.runGit(['switch', branch], projectDir, isDryRun);
  if (switchResult.exitCode !== 0) return switchResult;

  // 遠端尚無此分支時無從 pull，跳過
  if (!exists.remote) {
    log(chalk.gray('遠端尚無此分支，略過 pull'), 'info', '遠端尚無此分支，略過 pull');
    return switchResult;
  }

  // --ff-only：分支分岔時直接失敗並進入清理規約，不產生非預期的合併提交
  log(chalk.gray(`git pull --ff-only ${pushRemote} ${branch}`), 'info', `git pull --ff-only ${pushRemote} ${branch}`);
  return git.runGit(['pull', '--ff-only', pushRemote, branch], projectDir, isDryRun);
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
 * 清理規約 B 的本地重置
 *
 * 使用 preCommitSha 而非 HEAD~1：cherry-pick 若因來源為合併提交而產生
 * 多於一個提交，HEAD~1 會還原不完整。
 * 僅於 push 已失敗（遠端未變更）時呼叫，故本地重置即為完整回復。
 */
async function rollbackToSha({ git, log, projectDir, isDryRun, preCommitSha }) {
  if (!preCommitSha) {
    const warnMsg = `⚠ 缺少回退基準點，請手動確認狀態（目錄：${projectDir}）`;
    log(chalk.red(warnMsg), 'error', warnMsg);
    return;
  }

  const cmd = `git reset --hard ${preCommitSha}`;
  log(chalk.gray(`→ rollback: ${cmd}`), 'rollback', `→ rollback: ${cmd}`);

  const result = await git.runGit(['reset', '--hard', preCommitSha], projectDir, isDryRun);
  if (result.exitCode !== 0) {
    const warnMsg = `⚠ rollback 失敗，請手動還原：${cmd}（目錄：${projectDir}）`;
    log(chalk.red(warnMsg), 'error', warnMsg);
  }
}
