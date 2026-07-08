/**
 * reporter.js
 * 執行結果摘要輸出模組
 * 以清晰的表格與顏色區分成功/跳過/失敗
 */

import chalk from 'chalk';

/**
 * 輸出單次執行的摘要報告
 *
 * @param {Array<{ dir: string, status: string, reason: string|null }>} results
 * @param {boolean} isDryRun - 是否為模擬模式
 */
export function printSummary(results, isDryRun) {
  const separator = chalk.gray('─'.repeat(60));

  console.log('\n' + separator);
  console.log(
    chalk.bold.white('  📊 執行摘要') +
    (isDryRun ? chalk.bold.yellow('  【模擬模式 / DRY-RUN】') : '')
  );
  console.log(separator);

  const successful = results.filter((r) => r.status === 'success');
  const skipped    = results.filter((r) => r.status === 'skipped');
  const failed     = results.filter((r) => r.status === 'failed');

  // ── 成功 ──────────────────────────────────────────────────────────────────
  if (successful.length > 0) {
    console.log(chalk.green.bold(`\n  ✅ 成功（${successful.length}）`));
    for (const r of successful) {
      console.log(chalk.green(`     • ${r.dir}`));
    }
  }

  // ── 跳過 ──────────────────────────────────────────────────────────────────
  if (skipped.length > 0) {
    console.log(chalk.yellow.bold(`\n  ⏭  跳過（${skipped.length}）`));
    for (const r of skipped) {
      console.log(chalk.yellow(`     • ${r.dir}`));
      if (r.reason) {
        console.log(chalk.gray(`       原因：${r.reason}`));
      }
    }
  }

  // ── 失敗 ──────────────────────────────────────────────────────────────────
  if (failed.length > 0) {
    console.log(chalk.red.bold(`\n  ❌ 失敗（${failed.length}）`));
    for (const r of failed) {
      console.log(chalk.red(`     • ${r.dir}`));
      if (r.reason) {
        console.log(chalk.gray(`       原因：${r.reason}`));
      }
    }
  }

  // ── 總計 ──────────────────────────────────────────────────────────────────
  console.log('\n' + separator);
  console.log(
    `  總計：` +
    chalk.green(`成功 ${successful.length}`) + '  ' +
    chalk.yellow(`跳過 ${skipped.length}`) + '  ' +
    chalk.red(`失敗 ${failed.length}`) +
    `  / 共 ${results.length} 個專案`
  );
  console.log(separator + '\n');
}

/**
 * 在執行前輸出確認資訊
 */
export function printPlan({ projectDirs, branch, remote, commit, isDryRun }) {
  const separator = chalk.gray('─'.repeat(60));
  console.log('\n' + separator);
  console.log(
    chalk.bold.white('  🍒 Git AutoPick') +
    (isDryRun ? chalk.bold.yellow('  【模擬模式 / DRY-RUN】') : '')
  );
  console.log(separator);
  console.log(`  分支    : ${chalk.cyan(branch)}`);
  console.log(`  Remote  : ${chalk.cyan(remote)}`);
  console.log(`  Commit  : ${chalk.magenta(commit)}`);
  console.log(`  專案數  : ${chalk.white(projectDirs.length)} 個`);
  console.log(separator);
  for (const dir of projectDirs) {
    console.log(chalk.gray(`    ${dir}`));
  }
  console.log(separator + '\n');
}
