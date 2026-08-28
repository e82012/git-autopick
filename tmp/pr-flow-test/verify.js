/**
 * verify.js — PR 模式流程驗證
 *
 * 以注入接縫（gitRunner / prProvider）離線驗證指令序列，不接觸真實 repo。
 * 執行：node tmp/pr-flow-test/verify.js
 */

import { runCherryPickFlow, STATUS } from '../../src/cherryPickFlow.js';
import * as realGit from '../../src/gitRunner.js';
import { buildComparePrUrl, parsePrUrl } from '../../src/prProvider.js';

// ── 極簡測試框架 ────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ── Mock 建構 ───────────────────────────────────────────────────────────────

/** 所有情境累積的指令，供「全路徑無強制推送」掃描 */
const allCommands = [];

/**
 * 建立可記錄指令的 gitRunner mock
 * @param {object} opts
 * @param {{local:boolean, remote:boolean}} [opts.branchState]
 * @param {boolean} [opts.clean]
 * @param {object}  [opts.fail]        - { '指令前綴': { exitCode, stdout, stderr } }
 * @param {string}  [opts.currentBranch]
 * @param {boolean} [opts.detached]
 * @param {string|null} [opts.commitTitle]
 */
function makeGit(opts = {}) {
  const {
    branchState = { local: false, remote: false },
    clean = true,
    fail = {},
    currentBranch = 'main',
    detached = false,
    commitTitle = '修正結算金額四捨五入',
  } = opts;

  const calls = [];
  let headCounter = 0;

  return {
    calls,
    ...realGit,
    runGit: async (args) => {
      const cmd = args.join(' ');
      calls.push(cmd);
      allCommands.push(cmd);

      for (const [prefix, result] of Object.entries(fail)) {
        if (cmd.startsWith(prefix)) return { exitCode: 1, stdout: '', stderr: 'mock 失敗', ...result };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    queryGit: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    branchExists: async () => branchState,
    getCurrentBranch: async () => ({ name: currentBranch, isDetached: detached }),
    isWorkingTreeClean: async () => ({ clean, detail: clean ? '' : ' M src/app.js' }),
    getCommitTitle: async () => commitTitle,
    getHeadSha: async () => (headCounter++ === 0 ? 'SHA_BEFORE' : 'SHA_AFTER'),
  };
}

/** 建立 prProvider mock */
function makePr(result = {}, mergeResult = { merged: true, error: null }) {
  const received = [];
  const mergeCalls = [];
  return {
    received,
    mergeCalls,
    createPullRequest: async (params) => {
      received.push(params);
      return { url: 'https://github.com/acme/site/pull/42', created: true, error: null, ...result };
    },
    mergePullRequest: async (params) => {
      mergeCalls.push(params);
      return mergeResult;
    },
  };
}

const BASE = {
  projectDir: 'D:\\projects\\site-a',
  branch: 'feat/fix-rounding',
  remote: 'upstream',
  commit: 'abc1234',
  isDryRun: false,
};

// ── 1~4：分支就位四種組合 ───────────────────────────────────────────────────
section('分支就位判定');

{
  const git = makeGit({ branchState: { local: false, remote: false } });
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });
  check(
    '1. 全新分支：自 origin/main 切出',
    git.calls.includes('checkout -b feat/fix-rounding origin/main'),
    git.calls.join(' | '),
  );
}

{
  const git = makeGit({ branchState: { local: false, remote: true } });
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });
  check(
    '2. 遠端已有：switch 且不含 checkout -b',
    git.calls.includes('switch feat/fix-rounding') && !git.calls.some((c) => c.startsWith('checkout -b')),
    git.calls.join(' | '),
  );
}

{
  const git = makeGit({ branchState: { local: true, remote: true } });
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });
  check(
    '3. 本地既有：switch + pull --ff-only，且不與基準對齊',
    git.calls.includes('switch feat/fix-rounding') &&
    git.calls.includes('pull --ff-only origin feat/fix-rounding') &&
    !git.calls.some((c) => c.includes('origin/main') && c.startsWith('checkout')),
    git.calls.join(' | '),
  );
}

{
  const git = makeGit({ branchState: { local: true, remote: false } });
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });
  check(
    '4. 本地既有未推：switch 但不含 pull',
    git.calls.includes('switch feat/fix-rounding') && !git.calls.some((c) => c.startsWith('pull')),
    git.calls.join(' | '),
  );
}

// ── 5~7：高風險分支判定 ─────────────────────────────────────────────────────
section('高風險分支判定');

check('5. main 命中名單', realGit.isProtectedBranch('main') === true);
check('5b. feat/fix-rounding 未命中', realGit.isProtectedBranch('feat/fix-rounding') === false);
check('7. release/2026-08 命中 release/*', realGit.isProtectedBranch('release/2026-08') === true);
check(
  '7b. feat/main-page 不因含 main 而誤判',
  realGit.isProtectedBranch('feat/main-page') === false,
);
check(
  '7c. 自訂名單可覆寫預設',
  realGit.isProtectedBranch('trunk', ['trunk']) === true && realGit.isProtectedBranch('main', ['trunk']) === false,
);

// ── 6：高風險分支放行後指令序列與既有直推一致 ───────────────────────────────
section('直推模式回歸');

const LEGACY_SEQUENCE = [
  'switch main',
  'pull origin main',
  'fetch upstream',
  'cherry-pick abc1234',
  'push origin main',
];

{
  const git = makeGit({ branchState: { local: true, remote: true } });
  await runCherryPickFlow({ ...BASE, branch: 'main', gitRunner: git, prProvider: makePr() });
  check(
    '6. 直推 main 放行後，指令序列與改動前完全一致',
    JSON.stringify(git.calls) === JSON.stringify(LEGACY_SEQUENCE),
    `實際：${git.calls.join(' | ')}`,
  );
}

{
  // 18. CLI 回歸：僅以既有五個參數呼叫（不帶任何 PR 模式參數）
  const git = makeGit({ branchState: { local: true, remote: true } });
  const result = await runCherryPickFlow({
    projectDir: 'D:\\projects\\site-a',
    branch: 'main',
    remote: 'upstream',
    commit: 'abc1234',
    isDryRun: false,
    gitRunner: git,
    prProvider: makePr(),
  });
  check(
    '18. CLI 舊簽章呼叫：行為不變且回傳 SUCCESS',
    JSON.stringify(git.calls) === JSON.stringify(LEGACY_SEQUENCE) && result.status === STATUS.SUCCESS,
    `實際：${git.calls.join(' | ')} / status=${result.status}`,
  );
}

// ── 9：清理規約 A ───────────────────────────────────────────────────────────
section('清理規約 A（cherry-pick 失敗）');

{
  const git = makeGit({
    branchState: { local: false, remote: false },
    fail: { 'cherry-pick abc1234': { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict' } },
  });
  const result = await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });

  const abortIdx  = git.calls.indexOf('cherry-pick --abort');
  const switchIdx = git.calls.lastIndexOf('switch main');
  const deleteIdx = git.calls.indexOf('branch -D feat/fix-rounding');

  check(
    '9. 新建分支衝突：abort → 切回原分支 → 刪除臨時分支（順序正確）',
    abortIdx >= 0 && switchIdx > abortIdx && deleteIdx > switchIdx && result.status === STATUS.FAILED,
    git.calls.join(' | '),
  );
}

{
  const git = makeGit({
    branchState: { local: true, remote: true },
    fail: { 'cherry-pick abc1234': { exitCode: 1, stderr: 'CONFLICT (content): Merge conflict' } },
  });
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });
  check(
    '9b. 既有分支衝突：不得刪除該分支',
    !git.calls.some((c) => c.startsWith('branch -D')),
    git.calls.join(' | '),
  );
}

// ── 10：清理規約 B ──────────────────────────────────────────────────────────
section('清理規約 B（push 失敗）');

{
  const git = makeGit({
    branchState: { local: true, remote: true },
    fail: { 'push origin': { exitCode: 1, stderr: 'protected branch hook declined' } },
  });
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });
  check(
    '10. 既有分支 push 失敗：reset 至 preCommitSha（非 HEAD~1）',
    git.calls.includes('reset --hard SHA_BEFORE') && !git.calls.some((c) => c.includes('HEAD~1')),
    git.calls.join(' | '),
  );
}

{
  const git = makeGit({
    branchState: { local: false, remote: false },
    fail: { 'push origin': { exitCode: 1, stderr: 'permission denied' } },
  });
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });
  check(
    '10b. 新建分支 push 失敗：整條丟棄，不需 reset',
    git.calls.includes('branch -D feat/fix-rounding') && !git.calls.some((c) => c.startsWith('reset')),
    git.calls.join(' | '),
  );
}

// ── 11：清理規約 C ──────────────────────────────────────────────────────────
section('清理規約 C（push 成功、PR 建立失敗）');

{
  const git = makeGit({ branchState: { local: false, remote: false } });
  const pr  = makePr({ url: 'https://github.com/acme/site/compare/main...feat/fix-rounding?expand=1', created: false, error: 'gh pr create 失敗：HTTP 403' });
  const result = await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: pr,
  });

  const hasRollback = git.calls.some((c) => c.startsWith('reset') || c.startsWith('branch -D') || c.includes('revert'));

  check(
    '11. PR 失敗不回滾，狀態維持 SUCCESS 且 prError 有值',
    result.status === STATUS.SUCCESS && !hasRollback && Boolean(result.prError),
    `status=${result.status} / prError=${result.prError} / calls=${git.calls.join(' | ')}`,
  );
}

// ── 12：髒工作區攔截 ────────────────────────────────────────────────────────
section('前置檢查');

{
  const git = makeGit({ clean: false, branchState: { local: false, remote: false } });
  const result = await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });
  check(
    '12. 工作區有未提交變更：判定 FAILED 且未執行任何變更型指令',
    result.status === STATUS.FAILED && git.calls.length === 0,
    `status=${result.status} / calls=${git.calls.join(' | ') || '(無)'}`,
  );
}

{
  const git = makeGit({ branchState: { local: false, remote: false }, detached: true, currentBranch: 'DEADBEEF' });
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: makePr(),
  });
  check(
    '12b. detached HEAD：以 checkout <sha> 還原而非 switch',
    git.calls.includes('checkout DEADBEEF') && !git.calls.includes('switch DEADBEEF'),
    git.calls.join(' | '),
  );
}

// ── 14~16：URL 解析與組裝 ───────────────────────────────────────────────────
section('remote URL 解析與連結組裝');

check(
  '14. https 形式解析',
  JSON.stringify(realGit.parseOwnerRepo('https://github.com/acme/site.git')) === JSON.stringify({ owner: 'acme', repo: 'site' }),
);
check(
  '14b. scp-like ssh 形式解析',
  JSON.stringify(realGit.parseOwnerRepo('git@github.com:acme/site.git')) === JSON.stringify({ owner: 'acme', repo: 'site' }),
);
check(
  '14c. 無 .git 結尾亦可解析',
  JSON.stringify(realGit.parseOwnerRepo('https://github.com/acme/site')) === JSON.stringify({ owner: 'acme', repo: 'site' }),
);
check(
  '14d. 非 GitHub 回傳 null',
  realGit.parseOwnerRepo('https://gitlab.com/acme/site.git') === null,
);

check(
  '15. compare 連結組裝正確',
  buildComparePrUrl({ owner: 'acme', repo: 'site', targetBranch: 'main', branch: 'feat/fix' })
    === 'https://github.com/acme/site/compare/main...feat/fix?expand=1',
);
check(
  '15b. 分支名的斜線保留、特殊字元編碼',
  buildComparePrUrl({ owner: 'acme', repo: 'site', targetBranch: 'main', branch: 'feat/a b#c' })
    === 'https://github.com/acme/site/compare/main...feat/a%20b%23c?expand=1',
  buildComparePrUrl({ owner: 'acme', repo: 'site', targetBranch: 'main', branch: 'feat/a b#c' }),
);

check(
  '16. 自 push stderr 解析 PR 連結',
  parsePrUrl('', 'remote: Create a pull request for \'feat/x\' on GitHub by visiting:\nremote:   https://github.com/acme/site/pull/new/feat/x')
    === 'https://github.com/acme/site/pull/new/feat/x',
);
check(
  '16b. 無連結時回傳 null',
  parsePrUrl('', 'Everything up-to-date') === null,
);
check(
  '16c. 去除輸出換行帶入的結尾標點',
  parsePrUrl('', 'see https://github.com/acme/site/pull/42.') === 'https://github.com/acme/site/pull/42',
);

// ── 標題淨化 ────────────────────────────────────────────────────────────────
section('參數淨化');

check(
  '標題移除換行與控制字元、壓縮空白',
  realGit.sanitizeArgValue('修正   金額\n\r第二行\t結尾') === '修正 金額 第二行 結尾',
  realGit.sanitizeArgValue('修正   金額\n\r第二行\t結尾'),
);
check(
  '標題長度截斷至 255',
  realGit.sanitizeArgValue('あ'.repeat(400)).length === 255,
);
check(
  '含 shell 元字元的標題原樣保留（shell:false，不需跳脫）',
  realGit.sanitizeArgValue('fix: A & B | C ^D') === 'fix: A & B | C ^D',
);

{
  const git = makeGit({ branchState: { local: false, remote: false }, commitTitle: 'fix: 修正 A & B\n第二行' });
  const pr = makePr();
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', gitRunner: git, prProvider: pr,
  });
  check(
    '標題未填時自 commit 取得並淨化為單行',
    pr.received[0]?.title === 'fix: 修正 A & B 第二行',
    `實際：${pr.received[0]?.title}`,
  );
}

// ── 19~23：自動合併 ─────────────────────────────────────────────────────────
section('自動合併');

{
  const git = makeGit({ branchState: { local: false, remote: false } });
  const pr  = makePr();
  const result = await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', autoMerge: true,
    gitRunner: git, prProvider: pr,
  });

  const switchBackIdx = git.calls.lastIndexOf('switch main');
  check(
    '19. 合併前必須已切回原分支（--delete-branch 需離開該分支）',
    switchBackIdx >= 0 && pr.mergeCalls.length === 1,
    `切回索引=${switchBackIdx} / 合併呼叫=${pr.mergeCalls.length}`,
  );
  check(
    '19b. 合併成功：merged=true 且無 mergeError',
    result.merged === true && result.mergeError === null && result.status === STATUS.SUCCESS,
    `merged=${result.merged} / mergeError=${result.mergeError}`,
  );
  check(
    '19c. 合併參數正確傳遞',
    pr.mergeCalls[0]?.method === 'squash' && pr.mergeCalls[0]?.deleteBranch === true
      && pr.mergeCalls[0]?.branch === 'feat/fix-rounding',
    JSON.stringify(pr.mergeCalls[0]),
  );
}

{
  const git = makeGit({ branchState: { local: false, remote: false } });
  const pr  = makePr({}, { merged: false, error: '該分支的保護規則要求審核核准，無法自動合併' });
  const result = await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', autoMerge: true,
    gitRunner: git, prProvider: pr,
  });

  const hasRollback = git.calls.some((c) => c.startsWith('reset') || c.startsWith('branch -D'));
  check(
    '20. 清理規約 D：合併失敗不回退，狀態維持 SUCCESS 且保留 PR',
    result.status === STATUS.SUCCESS && result.merged === false
      && Boolean(result.mergeError) && Boolean(result.prUrl) && !hasRollback,
    `status=${result.status} / merged=${result.merged} / mergeError=${result.mergeError}`,
  );
}

{
  const git = makeGit({ branchState: { local: false, remote: false } });
  // 未實際建立 PR（開單連結軌道）時無合併對象
  const pr  = makePr({ url: 'https://github.com/acme/site/compare/main...feat/x?expand=1', created: false, error: null });
  const result = await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', autoMerge: true,
    gitRunner: git, prProvider: pr,
  });
  check(
    '21. 僅取得開單連結時不嘗試合併，並說明原因',
    pr.mergeCalls.length === 0 && result.merged === false && Boolean(result.mergeError),
    `合併呼叫=${pr.mergeCalls.length} / mergeError=${result.mergeError}`,
  );
}

{
  const git = makeGit({ branchState: { local: false, remote: false } });
  const pr  = makePr();
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main',
    gitRunner: git, prProvider: pr,
  });
  check(
    '22. autoMerge 未開啟時不呼叫合併（預設關閉）',
    pr.mergeCalls.length === 0,
  );
}

{
  const git = makeGit({ branchState: { local: false, remote: false } });
  const pr  = makePr();
  await runCherryPickFlow({
    ...BASE, isPrMode: true, targetBranch: 'main', autoMerge: true,
    mergeMethod: 'rebase', deleteBranchOnMerge: false,
    gitRunner: git, prProvider: pr,
  });
  check(
    '23. 合併方式與刪分支選項可覆寫',
    pr.mergeCalls[0]?.method === 'rebase' && pr.mergeCalls[0]?.deleteBranch === false,
    JSON.stringify(pr.mergeCalls[0]),
  );
}

// ── 8：全路徑無強制推送 ─────────────────────────────────────────────────────
section('全域約束');

const forceHits = allCommands.filter((cmd) =>
  /(^|\s)(--force|--force-with-lease|-f)(\s|$)/.test(cmd)
);

check(
  `8. 全部 ${allCommands.length} 筆指令皆不含 --force / --force-with-lease / -f`,
  forceHits.length === 0,
  forceHits.join(' | '),
);

// ── 結果 ────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(64)}`);
console.log(`  通過 ${passed} 項，失敗 ${failed} 項`);
if (failed > 0) {
  console.log('\n  失敗清單：');
  failures.forEach((f) => console.log(`    ✗ ${f}`));
}
console.log(`${'═'.repeat(64)}\n`);

process.exit(failed > 0 ? 1 : 0);
