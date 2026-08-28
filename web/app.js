/**
 * app.js — Git AutoPick Web UI 前端邏輯
 *
 * 功能：
 *  - 表單驗證（blur 時）
 *  - PR 模式切換與高風險分支確認閘門
 *  - POST /api/run，透過 Server-Sent Events 接收即時 log
 *  - 即時將 log 渲染到日誌面板
 *  - 執行完成後渲染摘要卡片（含 PR 連結）
 */

// ── DOM 引用 ──────────────────────────────────────────────────────────────
const form          = document.getElementById('pick-form');
const submitBtn     = document.getElementById('submit-btn');
const submitStatus  = document.getElementById('submit-status');
const clearBtn      = document.getElementById('clear-btn');
const logContainer  = document.getElementById('log-container');
const summarySection= document.getElementById('summary-section');
const summaryGrid   = document.getElementById('summary-grid');
const statusDot     = document.getElementById('status-dot');
const statusLabel   = document.getElementById('status-label');
const progressOverlay = document.getElementById('progress-overlay');

const updateOnlyToggle = document.getElementById('update-only');
const prModeRow        = document.getElementById('pr-mode-row');
const commitFieldGroup = document.getElementById('commit-field-group');
const pushRemoteGroup  = document.getElementById('push-remote-group');

const prModeToggle  = document.getElementById('pr-mode');
const prSettings    = document.getElementById('pr-settings');
const prTrackHint   = document.getElementById('pr-track-hint');
const autoMergeToggle = document.getElementById('auto-merge');
const mergeSettings   = document.getElementById('merge-settings');
const mergeStateHint  = document.getElementById('merge-state-hint');

const protectedWarning   = document.getElementById('protected-warning');
const protectedBranchName= document.getElementById('protected-branch-name');
const protectedDirCount  = document.getElementById('protected-dir-count');
const protectedDirList   = document.getElementById('protected-dir-list');
const confirmProtected   = document.getElementById('confirm-protected');

const fields = {
  branch:       document.getElementById('branch'),
  remote:       document.getElementById('remote'),
  pushRemote:   document.getElementById('push-remote'),
  commit:       document.getElementById('commit'),
  targetBranch: document.getElementById('target-branch'),
  concurrency:  document.getElementById('concurrency'),
};

const errors = {
  projectDirs:  document.getElementById('project-dirs-error'),
  branch:       document.getElementById('branch-error'),
  remote:       document.getElementById('remote-error'),
  pushRemote:   document.getElementById('push-remote-error'),
  commit:       document.getElementById('commit-error'),
  targetBranch: document.getElementById('target-branch-error'),
  concurrency:  document.getElementById('concurrency-error'),
};

const addDirBtn          = document.getElementById('add-dir-btn');
const projectDirsContainer= document.getElementById('project-dirs-container');
const dirListEmpty       = document.getElementById('dir-list-empty');
const dirCountBadge      = document.getElementById('dir-count-badge');

// 目錄狀態管理
let selectedDirs = [];

// 高風險分支名單（由 /api/capabilities 提供，取得前先用預設值避免閘門空窗）
let protectedPatterns = [
  'main', 'master', 'develop', 'dev', 'release/*',
  'production', 'prod', 'uat', 'stg', 'staging',
];

function renderDirList() {
  // 即時更新已選目錄數量
  const count = selectedDirs.length;
  dirCountBadge.textContent = String(count);
  dirCountBadge.classList.toggle('is-zero', count === 0);

  // 保留 empty placeholder，清空其他
  Array.from(projectDirsContainer.children).forEach(el => {
    if (el.id !== 'dir-list-empty') el.remove();
  });

  if (selectedDirs.length === 0) {
    dirListEmpty.style.display = 'block';
  } else {
    dirListEmpty.style.display = 'none';
    selectedDirs.forEach((dir, index) => {
      const item = document.createElement('div');
      item.className = 'dir-item';

      const pathSpan = document.createElement('span');
      pathSpan.className = 'dir-item-path';
      pathSpan.title = dir;
      pathSpan.textContent = dir;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'dir-item-remove';
      removeBtn.innerHTML = '✕';
      removeBtn.setAttribute('aria-label', `移除目錄：${dir}`);
      removeBtn.onclick = () => {
        // 先播放離場動效，動畫結束後才真正從資料移除（避免瞬間消失）
        item.classList.add('is-leaving');
        item.addEventListener('animationend', () => {
          selectedDirs.splice(index, 1);
          renderDirList();
          validateField('projectDirs');
          updateProtectedWarning();
        }, { once: true });
      };

      item.appendChild(pathSpan);
      item.appendChild(removeBtn);
      projectDirsContainer.appendChild(item);
    });
  }
}

addDirBtn.addEventListener('click', async () => {
  addDirBtn.disabled = true;
  addDirBtn.textContent = '選取中...';
  try {
    const res = await fetch('/api/select-folder');
    if (res.ok) {
      const data = await res.json();
      if (data.path && !selectedDirs.includes(data.path)) {
        selectedDirs.push(data.path);
        renderDirList();
        validateField('projectDirs');
        updateProtectedWarning();
      }
    }
  } catch (err) {
    console.error('選取目錄失敗', err);
  } finally {
    addDirBtn.disabled = false;
    addDirBtn.textContent = '+ 新增目錄';
  }
});

// ── 連線狀態與能力查詢 ─────────────────────────────────────────────────────
async function checkServerStatus() {
  try {
    const res = await fetch('/api/ping', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      statusDot.className = 'status-dot connected';
      statusLabel.textContent = '伺服器已連線';
    } else throw new Error();
  } catch {
    statusDot.className = 'status-dot disconnected';
    statusLabel.textContent = '伺服器未連線';
  }
}

/** 查詢後端能力，決定 PR 模式的提示文案與高風險分支名單 */
async function loadCapabilities() {
  try {
    const res = await fetch('/api/capabilities', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (Array.isArray(data.protectedBranches) && data.protectedBranches.length) {
      protectedPatterns = data.protectedBranches;
      updateProtectedWarning();
    }

    setGhTrack(data.ghAvailable && data.ghAuthenticated, data.ghReason);
  } catch {
    setGhTrack(false, '無法確認 gh CLI 狀態');
  }
}

/**
 * 依 gh 可用性設定提示文案與自動合併的可用狀態
 * 自動合併必須實際建立 PR 才有對象，開單連結軌道下不成立
 */
function setGhTrack(ghReady, reason) {
  if (ghReady) {
    prTrackHint.textContent = '✓ 已偵測到 gh CLI，將自動建立 PR';
    prTrackHint.dataset.track = 'auto';
    autoMergeToggle.disabled = false;
    autoMergeToggle.closest('.toggle-label').removeAttribute('title');
  } else {
    prTrackHint.textContent = `將產生預填的開單連結（${reason || '未偵測到 gh CLI'}）`;
    prTrackHint.dataset.track = 'link';
    autoMergeToggle.checked = false;
    autoMergeToggle.disabled = true;
    mergeSettings.hidden = true;
    autoMergeToggle.closest('.toggle-label').title = '自動合併需要 gh CLI 實際建立 PR';
  }
  updateMergeStateHint(ghReady);
}

/**
 * 說明流程會停在哪一步
 * 三種組合的終點不同，只寫「開啟時自動合併」會讓人看不出關閉後 PR 有沒有被建立
 */
function updateMergeStateHint(ghReady) {
  if (!ghReady) {
    mergeStateHint.textContent = '終點：推送完成，PR 需自行至 GitHub 建立與合併。';
    mergeStateHint.dataset.state = 'manual';
  } else if (autoMergeToggle.checked) {
    mergeStateHint.textContent = '終點：PR 建立後直接合併，無需人工介入。';
    mergeStateHint.dataset.state = 'auto';
  } else {
    mergeStateHint.textContent = '終點：PR 已建立並停在待合併，可自行至 GitHub 按下 Merge。';
    mergeStateHint.dataset.state = 'pending';
  }
}

checkServerStatus();
loadCapabilities();

// ── 高風險分支判定 ─────────────────────────────────────────────────────────

/** 與後端 isProtectedBranch 同一套比對規則：完全相等或 glob 前綴 */
function isProtectedBranch(branch) {
  const target = String(branch || '').trim();
  if (!target) return false;

  return protectedPatterns.some((pattern) => {
    if (!pattern.includes('*')) return pattern === target;
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(target);
  });
}

/**
 * 更新確認卡：列出這次會被直推的完整專案清單
 *
 * 抽象警語在多數專案可直推的環境下會頻繁出現，使用者將養成無條件勾選的習慣。
 * 列出具體路徑可使每次確認都攜帶實際資訊。
 */
function updateProtectedWarning() {
  const branch = fields.branch.value.trim();
  const isPrMode = prModeToggle.checked;
  // 僅更新分支不 push，主線分支拉最新是常態，不需高風險確認
  const shouldShow = !isPrMode && !updateOnlyToggle.checked
    && isProtectedBranch(branch) && selectedDirs.length > 0;

  if (!shouldShow) {
    protectedWarning.hidden = true;
    confirmProtected.checked = false;
    return;
  }

  protectedBranchName.textContent = branch;
  protectedDirCount.textContent = String(selectedDirs.length);
  protectedDirList.innerHTML = '';

  selectedDirs.forEach((dir) => {
    const li = document.createElement('li');
    li.textContent = dir;
    protectedDirList.appendChild(li);
  });

  protectedWarning.hidden = false;
}

// ── 僅更新分支切換 ─────────────────────────────────────────────────────────
// 此模式只做 switch → pull，與 cherry-pick／PR 無關的欄位一律隱藏，
// 避免使用者填了卻沒有作用而困惑。
updateOnlyToggle.addEventListener('change', () => {
  const on = updateOnlyToggle.checked;

  // 與 PR 模式互斥：開啟時強制關閉 PR 模式並收合其設定
  if (on && prModeToggle.checked) {
    prModeToggle.checked = false;
    prSettings.hidden = true;
  }

  // 隱藏不適用的欄位（commit、推送 remote、PR 模式整組）
  commitFieldGroup.hidden = on;
  pushRemoteGroup.hidden  = on;
  prModeRow.hidden        = on;
  if (on) prSettings.hidden = true;

  // 隱藏的欄位清掉殘留錯誤，避免擋住送出
  if (on) {
    ['commit', 'pushRemote', 'targetBranch'].forEach((name) => {
      errors[name].textContent = '';
      fields[name].classList.remove('is-invalid');
    });
  }

  updateProtectedWarning();
});

// ── PR 模式切換 ────────────────────────────────────────────────────────────
prModeToggle.addEventListener('change', () => {
  prSettings.hidden = !prModeToggle.checked;
  updateProtectedWarning();
  // 切換模式後目標分支的必填狀態改變，清掉可能殘留的錯誤訊息
  errors.targetBranch.textContent = '';
  fields.targetBranch.classList.remove('is-invalid');
});

autoMergeToggle.addEventListener('change', () => {
  mergeSettings.hidden = !autoMergeToggle.checked;
  updateMergeStateHint(!autoMergeToggle.disabled);
});

// ── 驗證規則 ──────────────────────────────────────────────────────────────
const validators = {
  projectDirs() {
    if (selectedDirs.length === 0) return '請至少新增一個專案目錄';
    return '';
  },
  branch(val) {
    if (!val.trim()) return '請輸入工作分支名稱';
    return '';
  },
  remote(val) {
    if (!val.trim()) return '請輸入 remote 名稱';
    return '';
  },
  pushRemote(val) {
    // 僅更新分支不 push，此欄位無作用
    if (updateOnlyToggle.checked) return '';
    if (!val.trim()) return '請輸入推送 remote 名稱';
    return '';
  },
  commit(val) {
    // 僅更新分支不做 cherry-pick，免填 commit
    if (updateOnlyToggle.checked) return '';
    if (!val.trim()) return '請輸入 commit hash';
    if (!/^[0-9a-f]{7,40}$/i.test(val.trim())) return 'commit hash 格式不正確（需 7~40 位 hex）';
    return '';
  },
  targetBranch(val) {
    // 僅 PR 模式為必填
    if (!prModeToggle.checked) return '';
    if (!val.trim()) return '請輸入合併目標分支';
    return '';
  },
  concurrency(val) {
    const num = Number(val);
    if (!val || isNaN(num) || !Number.isInteger(num) || num < 1 || num > 10) {
      return '請輸入 1 至 10 之間的整數';
    }
    return '';
  },
};

/** 驗證單一欄位，回傳是否合法 */
function validateField(name) {
  const val = fields[name] ? fields[name].value : null;
  const msg = validators[name](val);
  errors[name].textContent = msg;
  if (fields[name]) {
    fields[name].classList.toggle('is-invalid', Boolean(msg));
  } else if (name === 'projectDirs') {
    projectDirsContainer.classList.toggle('is-invalid', Boolean(msg));
  }
  return !msg;
}

/** 驗證所有欄位 */
function validateAll() {
  return Object.keys(validators).map((name) => validateField(name)).every(Boolean);
}

// Blur 時驗證
Object.keys(fields).forEach((name) => {
  fields[name].addEventListener('blur', () => validateField(name));
  fields[name].addEventListener('input', () => {
    if (errors[name].textContent) validateField(name);
  });
});

// 工作分支變動時即時更新確認卡
fields.branch.addEventListener('input', updateProtectedWarning);

// ── Log 渲染 ──────────────────────────────────────────────────────────────
let projectGroups = {};  // dir → DOM element

function ensureProjectGroup(dir) {
  if (projectGroups[dir]) return projectGroups[dir];

  logContainer.querySelector('[data-empty-state]')?.remove();
  logContainer.querySelector('.skeleton-group')?.remove();

  const group = document.createElement('div');
  group.className = 'log-project';
  group.dataset.dir = dir;

  const header = document.createElement('div');
  header.className = 'log-project-header';
  header.innerHTML = `<span class="log-project-header-icon" aria-hidden="true">📁</span><span>${escapeHtml(dir)}</span>`;
  group.appendChild(header);

  logContainer.appendChild(group);
  projectGroups[dir] = group;
  return group;
}

function appendLogLine(dir, level, message) {
  const group = ensureProjectGroup(dir);
  const line = document.createElement('span');
  line.className = 'log-line';
  line.dataset.level = level;
  line.textContent = message;
  group.appendChild(line);

  // 自動滾到底
  logContainer.scrollTop = logContainer.scrollHeight;
}

// ── 摘要渲染 ──────────────────────────────────────────────────────────────
function renderSummary(summary) {
  summaryGrid.innerHTML = '';
  summarySection.hidden = false;

  const cards = [
    { type: 'success', label: '✅ 成功', items: summary.successful },
    { type: 'skipped', label: '⏭  跳過', items: summary.skipped },
    { type: 'failed',  label: '❌ 失敗', items: summary.failed },
  ];

  for (const card of cards) {
    const el = document.createElement('div');
    el.className = `summary-card ${card.type}`;
    el.setAttribute('role', 'listitem');

    const itemsHtml = card.items.length
      ? `<ul class="summary-card-dirs" aria-label="${card.label}列表">
          ${card.items.map((item) => `
            <li>
              ${escapeHtml(typeof item === 'string' ? item : item.dir)}
              ${item.reason ? `<div class="reason">${escapeHtml(item.reason)}</div>` : ''}
              ${item.merged ? `<div class="reason merged">✓ 已合併</div>` : ''}
              ${renderPrLink(item)}
              ${item.prError ? `<div class="reason warn">${escapeHtml(item.prError)}</div>` : ''}
              ${item.mergeError ? `<div class="reason warn">${escapeHtml(item.mergeError)}</div>` : ''}
            </li>
          `).join('')}
        </ul>`
      : `<p class="summary-card-empty">無</p>`;

    el.innerHTML = `
      <div class="summary-card-header">
        <span class="summary-card-label">${card.label}</span>
        <span class="summary-card-count">${card.items.length}</span>
      </div>
      ${itemsHtml}
    `;

    summaryGrid.appendChild(el);
  }
}

/**
 * 產生 PR 連結 HTML
 *
 * prUrl 來自 git 或 gh 的輸出（外部來源），escapeHtml 可擋標籤但擋不住
 * javascript: scheme，故必須先通過 https 白名單才輸出為連結。
 */
function renderPrLink(item) {
  if (!item || typeof item !== 'object' || !item.prUrl) return '';
  if (!/^https:\/\//.test(item.prUrl)) {
    return `<div class="reason">${escapeHtml(item.prUrl)}</div>`;
  }

  const text = item.prCreated ? '🔗 前往 PR' : '🔗 前往開單';
  return `<a class="pr-link" href="${escapeHtml(item.prUrl)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

// ── 執行流程 ──────────────────────────────────────────────────────────────
const skeletonTemplate = document.getElementById('skeleton-template');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validateAll()) return;

  const isUpdateOnly = updateOnlyToggle.checked;
  const isPrMode = !isUpdateOnly && prModeToggle.checked;
  const branch = fields.branch.value.trim();

  // 高風險分支閘門：後端會再擋一次，此處僅為即時回饋
  // 僅更新分支不 push，跳過此閘門
  if (!isUpdateOnly && !isPrMode && isProtectedBranch(branch) && !confirmProtected.checked) {
    updateProtectedWarning();
    submitStatus.textContent = '請先確認直接推送高風險分支';
    confirmProtected.focus();
    return;
  }

  // 清空舊輸出
  projectGroups = {};
  logContainer.innerHTML = '';
  summarySection.hidden = true;
  summaryGrid.innerHTML  = '';

  // 送出請求到首筆 SSE 事件抵達前，顯示 skeleton 取代靜態文字（apple-fluid-motion §14：loading 動畫保留，僅移除空間位移）
  const skeletonNode = skeletonTemplate.content.cloneNode(true);
  logContainer.appendChild(skeletonNode);
  const skeletonEl = logContainer.querySelector('.skeleton-group');

  const isDryRun = document.getElementById('dry-run').checked;
  const payload = {
    projectDirs: selectedDirs,
    branch,
    remote:      fields.remote.value.trim(),
    pushRemote:  fields.pushRemote.value.trim() || 'origin',
    commit:      isUpdateOnly ? undefined : fields.commit.value.trim(),
    concurrency: Number(fields.concurrency.value) || 3,
    isDryRun,
    isUpdateOnly,
    isPrMode,
    targetBranch: isPrMode ? fields.targetBranch.value.trim() : undefined,
    prTitle:      isPrMode ? document.getElementById('pr-title').value.trim() : undefined,
    confirmProtectedPush: confirmProtected.checked,
    autoMerge:    isPrMode && autoMergeToggle.checked,
    mergeMethod:  document.getElementById('merge-method').value,
    deleteBranchOnMerge: document.getElementById('delete-branch-on-merge').checked,
  };

  // 更新 UI 狀態：執行中
  setRunning(true);

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    // 讀取 SSE 串流
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 移除 skeleton
    skeletonEl?.remove();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留不完整的行

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          handleSSEEvent(currentEvent, data);
        }
      }
    }

  } catch (err) {
    skeletonEl?.remove();
    appendLogLine('系統', 'error', `✗ 執行失敗：${err.message}`);
    submitStatus.textContent = `執行失敗：${err.message}`;
  } finally {
    setRunning(false);
  }
});

/** 處理單一 SSE 事件 */
function handleSSEEvent(event, data) {
  switch (event) {
    case 'project-start':
      ensureProjectGroup(data.dir);
      break;

    case 'log':
      appendLogLine(data.dir, data.level, data.message);
      break;

    case 'project-done': {
      const group = projectGroups[data.dir];
      if (group) {
        const header = group.querySelector('.log-project-header');
        if (header) {
          const badgeText = { success: '成功', skipped: '跳過', failed: '失敗' }[data.status] || data.status;
          const badge = document.createElement('span');
          badge.className = `log-project-badge ${data.status}`;
          badge.textContent = badgeText;
          header.appendChild(badge);

          if (data.prUrl && /^https:\/\//.test(data.prUrl)) {
            const link = document.createElement('a');
            link.className = 'pr-link';
            link.href = data.prUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = data.prCreated ? '🔗 前往 PR' : '🔗 前往開單';
            header.appendChild(link);
          }
        }
      }
      break;
    }

    case 'summary':
      renderSummary(data);
      submitStatus.textContent = `執行完成：成功 ${data.successful.length}，跳過 ${data.skipped.length}，失敗 ${data.failed.length}`;
      break;

    case 'done':
      break;
  }
}

// ── UI 狀態切換 ───────────────────────────────────────────────────────────
function setRunning(running) {
  submitBtn.disabled = running;
  progressOverlay.hidden = !running;
  progressOverlay.setAttribute('aria-hidden', String(!running));

  const icon = submitBtn.querySelector('.btn-icon');
  const text = submitBtn.querySelector('.btn-text');

  if (running) {
    submitBtn.classList.add('is-running');
    icon.textContent = '◌';
    text.textContent = '執行中...';
  } else {
    submitBtn.classList.remove('is-running');
    icon.textContent = '▶';
    text.textContent = '開始執行';
  }
}

// ── 清除按鈕 ──────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  projectGroups = {};
  logContainer.innerHTML = '';
  summarySection.hidden = true;
  summaryGrid.innerHTML  = '';
  submitStatus.textContent = '';

  const emptyEl = document.createElement('div');
  emptyEl.id = 'log-empty';
  emptyEl.className = 'log-empty';
  emptyEl.dataset.emptyState = '';
  emptyEl.innerHTML = `<span aria-hidden="true">🌿</span><p>執行後日誌將顯示於此</p>`;
  logContainer.appendChild(emptyEl);
});

// ── XSS 防護 ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
