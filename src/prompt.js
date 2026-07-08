/**
 * prompt.js
 * 互動式輸入模組（使用 inquirer）
 * 收集：目標專案目錄、分支、remote、commit hash
 */

import inquirer from 'inquirer';
import { existsSync } from 'fs';
import path from 'path';

/**
 * 驗證輸入的目錄字串是否合法（存在且為目錄）
 * @param {string} input - 逗號或換行分隔的目錄路徑
 * @returns {true | string} - 合法回傳 true，否則回傳錯誤訊息
 */
function validateDirectories(input) {
  if (!input.trim()) return '請至少輸入一個目錄路徑';

  const dirs = parseDirs(input);
  const invalidDirs = dirs.filter((d) => !existsSync(d));

  if (invalidDirs.length > 0) {
    return `以下目錄不存在，請確認路徑：\n  ${invalidDirs.join('\n  ')}`;
  }
  return true;
}

/**
 * 解析目錄字串（支援逗號、分號、換行分隔）
 * @param {string} input
 * @returns {string[]}
 */
export function parseDirs(input) {
  return input
    .split(/[,;\n]+/)
    .map((s) => path.normalize(s.trim()))
    .filter(Boolean);
}

/**
 * 驗證 commit hash 格式（至少 7 位 hex）
 * @param {string} input
 * @returns {true | string}
 */
function validateCommit(input) {
  const trimmed = input.trim();
  if (!trimmed) return '請輸入 commit hash';
  if (!/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    return 'commit hash 格式不正確（需為 7~40 位 hex 字元）';
  }
  return true;
}

/**
 * 收集使用者輸入
 * @returns {Promise<{ projectDirs: string[], branch: string, remote: string, commit: string }>}
 */
export async function promptInputs() {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectDirs',
      message: '目標專案目錄（多個請用逗號或分號分隔）：',
      validate: validateDirectories,
    },
    {
      type: 'input',
      name: 'branch',
      message: '目標分支（target_branch）：',
      default: 'main',
      validate: (v) => v.trim() ? true : '請輸入分支名稱',
    },
    {
      type: 'input',
      name: 'remote',
      message: 'Fetch 使用的 remote（target_remote）：',
      default: 'upstream',
      validate: (v) => v.trim() ? true : '請輸入 remote 名稱',
    },
    {
      type: 'input',
      name: 'commit',
      message: 'Cherry-pick 的 commit hash：',
      validate: validateCommit,
    },
  ]);

  return {
    projectDirs: parseDirs(answers.projectDirs),
    branch:      answers.branch.trim(),
    remote:      answers.remote.trim(),
    commit:      answers.commit.trim(),
  };
}
