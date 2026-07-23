/**
 * app.js — Git AutoPick Web UI 前端邏輯
 *
 * 功能：
 *  - 表單驗證（blur 時）
 *  - POST /api/run，透過 Server-Sent Events 接收即時 log
 *  - 即時將 log 渲染到日誌面板
 *  - 執行完成後渲染摘要卡片
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

const fields = {
  branch:      document.getElementById('branch'),
  remote:      document.getElementById('remote'),
  commit:      document.getElementById('commit'),
};

const errors = {
  projectDirs: document.getElementById('project-dirs-error'),
  branch:      document.getElementById('branch-error'),
  remote:      document.getElementById('remote-error'),
  commit:      document.getElementById('commit-error'),
};

const addDirBtn          = document.getElementById('add-dir-btn');
const projectDirsContainer= document.getElementById('project-dirs-container');
const dirListEmpty       = document.getElementById('dir-list-empty');

// 目錄狀態管理
let selectedDirs = [];

function renderDirList() {
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
      }
    }
  } catch (err) {
    console.error('選取目錄失敗', err);
  } finally {
    addDirBtn.disabled = false;
    addDirBtn.textContent = '+ 新增目錄';
  }
});

// ── 連線狀態檢查 ───────────────────────────────────────────────────────────
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

checkServerStatus();

// ── 驗證規則 ──────────────────────────────────────────────────────────────
const validators = {
  projectDirs() {
    if (selectedDirs.length === 0) return '請至少新增一個專案目錄';
    return '';
  },
  branch(val) {
    if (!val.trim()) return '請輸入分支名稱';
    return '';
  },
  remote(val) {
    if (!val.trim()) return '請輸入 remote 名稱';
    return '';
  },
  commit(val) {
    if (!val.trim()) return '請輸入 commit hash';
    if (!/^[0-9a-f]{7,40}$/i.test(val.trim())) return 'commit hash 格式不正確（需 7~40 位 hex）';
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

// ── 不再需要字串解析 ──────────────────────────────────────────────────────

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
    {
      type: 'success',
      label: '✅ 成功',
      count: summary.successful.length,
      items: summary.successful.map((dir) => ({ dir, reason: null })),
    },
    {
      type: 'skipped',
      label: '⏭  跳過',
      count: summary.skipped.length,
      items: summary.skipped,
    },
    {
      type: 'failed',
      label: '❌ 失敗',
      count: summary.failed.length,
      items: summary.failed,
    },
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
            </li>
          `).join('')}
        </ul>`
      : `<p class="summary-card-empty">無</p>`;

    el.innerHTML = `
      <div class="summary-card-header">
        <span class="summary-card-label">${card.label}</span>
        <span class="summary-card-count">${card.count}</span>
      </div>
      ${itemsHtml}
    `;

    summaryGrid.appendChild(el);
  }
}

// ── 執行流程 ──────────────────────────────────────────────────────────────
const skeletonTemplate = document.getElementById('skeleton-template');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validateAll()) return;

  // 清空舊輸出
  projectGroups = {};
  logContainer.innerHTML = '';
  summarySection.hidden = true;
  summaryGrid.innerHTML  = '';

  // 送出請求到首筆 SSE 事件抵達前，顯示 skeleton 取代靜態文字（apple-fluid-motion §14：loading 動畫保留，僅移除空間位移）
  const skeletonNode = skeletonTemplate.content.cloneNode(true);
  logContainer.appendChild(skeletonNode);
  const skeletonEl = logContainer.querySelector('.skeleton-group');

  const isDryRun   = document.getElementById('dry-run').checked;
  const payload = {
    projectDirs: selectedDirs,
    branch:    fields.branch.value.trim(),
    remote:    fields.remote.value.trim(),
    commit:    fields.commit.value.trim(),
    isDryRun,
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
