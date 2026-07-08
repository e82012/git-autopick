/**
 * index.js — Git AutoPick 入口點
 *
 * 使用方式：
 *   node index.js             # 正常執行
 *   node index.js --dry-run   # 模擬模式（不實際執行 git 命令）
 *   npm run pick              # 正常執行（via package.json scripts）
 *   npm run dry               # 模擬模式（via package.json scripts）
 */

import chalk from 'chalk';
import { promptInputs } from './src/prompt.js';
import { runCherryPickFlow, STATUS } from './src/cherryPickFlow.js';
import { printPlan, printSummary } from './src/reporter.js';

// ── 解析 CLI 參數 ──────────────────────────────────────────────────────────
const isDryRun = process.argv.includes('--dry-run');

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log(chalk.bold.magenta('\n  🍒 Git AutoPick — 自動化 Cherry-Pick 工具\n'));

  if (isDryRun) {
    console.log(chalk.yellow.bold('  ⚠  模擬模式已啟用：所有 git 命令僅顯示，不實際執行\n'));
  }

  // 1. 互動式輸入
  let inputs;
  try {
    inputs = await promptInputs();
  } catch (err) {
    // 使用者按下 Ctrl+C 取消
    console.log(chalk.gray('\n已取消。'));
    process.exit(0);
  }

  const { projectDirs, branch, remote, commit } = inputs;

  // 2. 輸出執行前確認資訊
  printPlan({ projectDirs, branch, remote, commit, isDryRun });

  // 3. 逐一對每個專案執行 cherry-pick 流程
  const results = [];

  for (const dir of projectDirs) {
    console.log(chalk.bold(`\n📁 處理：${dir}`));

    let flowResult;
    try {
      flowResult = await runCherryPickFlow({
        projectDir: dir,
        branch,
        remote,
        commit,
        isDryRun,
      });
    } catch (unexpectedErr) {
      // 防禦性捕捉：正常情況下 runCherryPickFlow 內部已處理所有錯誤
      flowResult = {
        status: STATUS.FAILED,
        reason: `未預期錯誤：${unexpectedErr.message}`,
      };
      console.log(chalk.red(`  ✗ 未預期錯誤：${unexpectedErr.message}`));
    }

    results.push({ dir, ...flowResult });
  }

  // 4. 輸出摘要
  printSummary(results, isDryRun);

  // 5. 以失敗數量決定 exit code（方便 CI 使用）
  const failCount = results.filter((r) => r.status === STATUS.FAILED).length;
  process.exit(failCount > 0 ? 1 : 0);
}

main();
