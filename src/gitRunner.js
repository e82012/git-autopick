/**
 * gitRunner.js
 * Git 命令執行核心模組
 * - 使用 child_process.spawn 執行 git 命令
 * - 精確捕捉 exit code（主要判斷依據）與 stderr（錯誤訊息）
 * - 支援 dry-run 模式：僅輸出命令，不實際執行
 */

import { spawn } from 'child_process';
import chalk from 'chalk';

/**
 * 執行單一 git 命令
 * @param {string[]} args        - git 子命令與參數，例如 ['pull', 'origin', 'main']
 * @param {string}   cwd         - 執行目錄（專案路徑）
 * @param {boolean}  isDryRun    - 是否為模擬模式
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export function runGit(args, cwd, isDryRun = false) {
  const displayCmd = `git ${args.join(' ')}`;

  if (isDryRun) {
    console.log(chalk.gray(`  [DRY-RUN] ${displayCmd}`));
    // 模擬成功（exit code 0）
    return Promise.resolve({ exitCode: 0, stdout: '[dry-run]', stderr: '' });
  }

  return new Promise((resolve) => {
    const stdout_chunks = [];
    const stderr_chunks = [];

    const proc = spawn('git', args, {
      cwd,
      // 不繼承 stdio，完整捕捉輸出
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 相容：使用 shell 模式避免找不到 git
      shell: process.platform === 'win32',
    });

    proc.stdout.on('data', (chunk) => stdout_chunks.push(chunk.toString()));
    proc.stderr.on('data', (chunk) => stderr_chunks.push(chunk.toString()));

    proc.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: stdout_chunks.join('').trim(),
        stderr: stderr_chunks.join('').trim(),
      });
    });

    proc.on('error', (err) => {
      // spawn 本身失敗（例如找不到 git）
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: `spawn error: ${err.message}`,
      });
    });
  });
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
