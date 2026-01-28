import type {
  CommentItem,
  CommentStatus,
  CommentType,
  NodeInfo,
  PluginMessage,
} from '../types';
import { analyzeComment, classifyComment, reAnalyzeComment } from './ai';

// ── State ──────────────────────────────────────────────────────
interface AppState {
  view: 'setup' | 'inbox' | 'focus';
  claudeApiKey: string;
  figmaToken: string;
  fileKey: string;
  comments: CommentItem[];
  selectedCommentId: string | null;
  loading: boolean;
}

const state: AppState = {
  view: 'setup',
  claudeApiKey: '',
  figmaToken: '',
  fileKey: '',
  comments: [],
  selectedCommentId: null,
  loading: false,
};

// ── DOM Helpers ────────────────────────────────────────────────
function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function show(id: string) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function hide(id: string) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function showView(view: 'setup' | 'inbox' | 'focus') {
  state.view = view;
  hide('setup-view');
  hide('inbox-view');
  hide('focus-view');
  show(`${view}-view`);
}

function showLoading(text: string) {
  state.loading = true;
  $('loading-text').textContent = text;
  show('loading-overlay');
}

function hideLoading() {
  state.loading = false;
  hide('loading-overlay');
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast toast-${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('hidden');
  }, 2500);
}

// ── Plugin Message Helpers ─────────────────────────────────────
function postToPlugin(msg: object) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

/**
 * Promise-based message exchange with the plugin sandbox.
 * Includes timeout to prevent hanging. Optionally matches on a `key` field.
 */
function requestFromPlugin<T extends PluginMessage>(
  msg: object,
  responseType: string,
  matchKey?: string,
  timeoutMs: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error(`Plugin response timeout for "${responseType}"`));
    }, timeoutMs);

    const handler = (event: MessageEvent) => {
      const data = event.data?.pluginMessage as PluginMessage | undefined;
      if (!data || data.type !== responseType) return;
      if (matchKey && 'key' in data && (data as { key: string }).key !== matchKey) return;

      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(data as T);
    };
    window.addEventListener('message', handler);
    postToPlugin(msg);
  });
}

// ── Figma REST API ─────────────────────────────────────────────
interface FigmaComment {
  id: string;
  message: string;
  resolved_at: string | null;
  created_at: string;
  user: { handle: string; img_url: string };
  client_meta: { node_id?: string; node_offset?: object; x?: number; y?: number } | null;
  parent_id: string;
  order_id: string;
}

async function fetchComments(fileKey: string, token: string): Promise<FigmaComment[]> {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
    headers: { 'X-Figma-Token': token },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Figma API error (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.comments || [];
}

// ── Transform Figma Comments → CommentItems ────────────────────
function transformComments(raw: FigmaComment[]): CommentItem[] {
  return raw
    .filter((c) => !c.parent_id && !c.resolved_at)
    .map((c) => ({
      id: c.id,
      message: c.message,
      author: c.user.handle,
      authorAvatar: c.user.img_url,
      pageOrFrame: '',
      status: 'pending' as CommentStatus,
      commentType: 'unknown' as CommentType,
      nodeId: c.client_meta?.node_id || null,
      proposal: null,
      resolved: false,
      createdAt: c.created_at,
    }));
}

// ── Render: Setup ──────────────────────────────────────────────
function initSetup() {
  $('save-keys-btn').addEventListener('click', async () => {
    const claudeKey = (document.getElementById('claude-key') as HTMLInputElement).value.trim();
    const figmaToken = (document.getElementById('figma-token') as HTMLInputElement).value.trim();

    if (!claudeKey || !figmaToken) {
      show('setup-error');
      $('setup-error').textContent = 'Both keys are required.';
      return;
    }

    hide('setup-error');
    state.claudeApiKey = claudeKey;
    state.figmaToken = figmaToken;

    // Save to plugin storage (fire and forget)
    postToPlugin({ type: 'store-set', key: 'claude-api-key', value: claudeKey });
    postToPlugin({ type: 'store-set', key: 'figma-token', value: figmaToken });

    await loadComments();
  });
}

// ── Render: Inbox ──────────────────────────────────────────────
function renderInbox() {
  const list = $('comment-list');
  const empty = $('inbox-empty');
  const stats = $('inbox-stats');

  if (state.comments.length === 0) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    stats.innerHTML = '';
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');

  const counts: Record<string, number> = {};
  for (const c of state.comments) {
    counts[c.status] = (counts[c.status] || 0) + 1;
  }

  const statusLabels: Record<string, string> = {
    pending: 'Pending',
    proposal_ready: 'Ready',
    needs_clarification: 'Unclear',
    applied: 'Applied',
    skipped: 'Skipped',
  };

  const statusIcons: Record<string, string> = {
    pending: '\u23F3',
    proposal_ready: '\uD83E\uDD16',
    needs_clarification: '\u26A0\uFE0F',
    applied: '\u2705',
    skipped: '\u26D4',
  };

  stats.innerHTML = Object.entries(counts)
    .map(
      ([s, n]) =>
        `<span class="stat-badge">${statusIcons[s] || ''} ${n} ${statusLabels[s] || s}</span>`
    )
    .join('');

  list.innerHTML = state.comments
    .map((c) => {
      const typeLabel = formatCommentType(c.commentType);
      const statusClass = `status-${c.status}`;
      const appliedClass = c.status === 'applied' ? ' applied' : '';

      return `
        <div class="comment-card${appliedClass}" data-id="${c.id}">
          <div class="comment-status-icon ${statusClass}">
            ${statusIcons[c.status] || '?'}
          </div>
          <div class="comment-body">
            <div class="comment-meta">
              <span class="comment-author">${escapeHtml(c.author)}</span>
              <span class="comment-type-badge">${typeLabel}</span>
            </div>
            <div class="comment-text">${escapeHtml(c.message)}</div>
            ${c.pageOrFrame ? `<div class="comment-frame">${escapeHtml(c.pageOrFrame)}</div>` : ''}
          </div>
        </div>
      `;
    })
    .join('');

  list.querySelectorAll('.comment-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = (card as HTMLElement).dataset.id!;
      openFocusView(id);
    });
  });
}

function formatCommentType(t: CommentType): string {
  const map: Record<CommentType, string> = {
    text_change: 'Text',
    color_change: 'Color',
    delete_hide: 'Delete/Hide',
    duplicate: 'Duplicate',
    unknown: 'Other',
  };
  return map[t] || 'Other';
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Render: Focus View ─────────────────────────────────────────
async function openFocusView(commentId: string) {
  state.selectedCommentId = commentId;
  const comment = state.comments.find((c) => c.id === commentId);
  if (!comment) return;

  showView('focus');

  if (comment.nodeId) {
    postToPlugin({ type: 'select-node', nodeId: comment.nodeId });
  }

  renderFocusComment(comment);

  if (!comment.proposal && comment.status === 'pending') {
    await generateProposal(comment);
  } else {
    renderFocusProposal(comment);
  }

  renderFocusActions(comment);
}

function renderFocusComment(comment: CommentItem) {
  const el = $('focus-comment');
  el.innerHTML = `
    <h3>Comment</h3>
    <div class="focus-comment-text">${escapeHtml(comment.message)}</div>
    <div class="focus-author">By ${escapeHtml(comment.author)} &middot; ${formatDate(comment.createdAt)}</div>
    <div id="focus-node-box"></div>
  `;

  if (comment.nodeId) {
    requestFromPlugin<Extract<PluginMessage, { type: 'node-info' }>>(
      { type: 'get-node-info', nodeId: comment.nodeId },
      'node-info'
    ).then((msg) => {
      const box = document.getElementById('focus-node-box');
      if (!box) return;
      if (msg.info) {
        box.innerHTML = `
          <div class="focus-node-info">
            <span><strong>Node:</strong> ${escapeHtml(msg.info.name)} (${msg.info.type})</span>
            ${msg.info.text !== undefined ? `<span><strong>Text:</strong> "${escapeHtml(msg.info.text)}"</span>` : ''}
            ${msg.info.fills?.length ? `<span><strong>Fill:</strong> ${formatFill(msg.info.fills[0])}</span>` : ''}
            ${msg.info.parentName ? `<span><strong>Frame:</strong> ${escapeHtml(msg.info.parentName)}</span>` : ''}
          </div>
        `;
      } else {
        box.innerHTML = `<div class="focus-node-info">Node not found on canvas.</div>`;
      }
    }).catch(() => {
      // Node info fetch failed silently
    });
  }
}

function formatFill(fill: NonNullable<NodeInfo['fills']>[0]): string {
  if (fill.type === 'SOLID' && fill.color) {
    const hex = rgbToHex(fill.color.r, fill.color.g, fill.color.b);
    return `<span style="display:inline-block;width:10px;height:10px;background:${hex};border-radius:2px;border:1px solid #ccc;vertical-align:middle;margin-right:4px;"></span>${hex}`;
  }
  return fill.type;
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

async function generateProposal(comment: CommentItem) {
  const proposalEl = $('focus-proposal');
  proposalEl.innerHTML = `
    <h3>Proposed Changes</h3>
    <div class="proposal-loading"><span class="spinner-inline"></span> Analyzing comment...</div>
  `;

  try {
    let nodeInfo: NodeInfo | null = null;
    if (comment.nodeId) {
      try {
        const msg = await requestFromPlugin<Extract<PluginMessage, { type: 'node-info' }>>(
          { type: 'get-node-info', nodeId: comment.nodeId },
          'node-info'
        );
        nodeInfo = msg.info;
      } catch {
        nodeInfo = null;
      }

      if (nodeInfo === null) {
        comment.status = 'needs_clarification';
        comment.proposal = {
          confidence: 'low',
          commentType: 'unknown',
          actions: [],
          explanation: 'The target node could not be found on the canvas.',
        };
        renderFocusProposal(comment);
        renderFocusActions(comment);
        return;
      }

      if (nodeInfo.locked) {
        comment.status = 'needs_clarification';
        comment.proposal = {
          confidence: 'low',
          commentType: 'unknown',
          actions: [],
          explanation: 'The target node is locked and cannot be modified.',
        };
        renderFocusProposal(comment);
        renderFocusActions(comment);
        return;
      }
    }

    const nodeId = comment.nodeId || '';
    const proposal = await analyzeComment(
      state.claudeApiKey,
      comment.message,
      nodeId,
      nodeInfo
    );

    comment.proposal = proposal;
    comment.commentType = proposal.commentType;

    if (proposal.actions.length === 0 || proposal.confidence === 'low') {
      comment.status = proposal.actions.length === 0 ? 'needs_clarification' : 'proposal_ready';
    } else {
      comment.status = 'proposal_ready';
    }

    renderFocusProposal(comment);
    renderFocusActions(comment);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    proposalEl.innerHTML = `
      <h3>Proposed Changes</h3>
      <div class="proposal-error">Failed to analyze comment: ${escapeHtml(message)}</div>
    `;
    renderFocusActions(comment);
  }
}

function renderFocusProposal(comment: CommentItem) {
  const el = $('focus-proposal');

  if (!comment.proposal) {
    el.innerHTML = `<h3>Proposed Changes</h3><p class="proposal-loading">No proposal yet.</p>`;
    return;
  }

  const p = comment.proposal;

  if (comment.status === 'needs_clarification') {
    el.innerHTML = `
      <h3>Proposed Changes</h3>
      <div class="needs-clarification">
        <strong>Needs Clarification</strong><br/>
        ${escapeHtml(p.explanation)}
      </div>
    `;
    return;
  }

  if (comment.status === 'applied') {
    el.innerHTML = `
      <h3>Proposed Changes</h3>
      <div class="proposal-card" style="border-color:#059669;">
        <div class="proposal-confidence confidence-high">Applied</div>
        <p style="font-size:12px;color:#065f46;">Changes have been applied successfully.</p>
      </div>
    `;
    return;
  }

  if (comment.status === 'skipped') {
    el.innerHTML = `
      <h3>Proposed Changes</h3>
      <div class="proposal-card" style="opacity:0.6;">
        <div class="proposal-confidence" style="background:#f3f4f6;color:#6b7280;">Skipped</div>
      </div>
    `;
    return;
  }

  const actionIcons: Record<string, string> = {
    change_text: 'T',
    change_color: 'C',
    delete_node: 'X',
    hide_node: 'H',
    duplicate_node: 'D',
  };

  const actionsHtml = p.actions
    .map(
      (a) => `
      <li>
        <span class="action-icon">${actionIcons[a.type] || '?'}</span>
        <span>${escapeHtml(a.description)}</span>
      </li>
    `
    )
    .join('');

  el.innerHTML = `
    <h3>Proposed Changes</h3>
    <div class="proposal-card">
      <div class="proposal-confidence confidence-${p.confidence}">${p.confidence} confidence</div>
      ${p.actions.length > 0 ? `<ul class="proposal-actions-list">${actionsHtml}</ul>` : '<p style="font-size:12px;color:#666;margin:8px 0;">No specific actions identified.</p>'}
      <div class="proposal-explanation">${escapeHtml(p.explanation)}</div>
    </div>
  `;
}

function renderFocusActions(comment: CommentItem) {
  const el = $('focus-actions');

  if (comment.status === 'applied' || comment.status === 'skipped') {
    el.innerHTML = `
      <button class="btn-secondary" id="back-to-list-btn">Back to list</button>
    `;
    $('back-to-list-btn').addEventListener('click', () => {
      $('back-btn').click();
    });
    return;
  }

  const canApply =
    comment.proposal &&
    comment.proposal.actions.length > 0 &&
    comment.status === 'proposal_ready';

  el.innerHTML = `
    <button class="btn-apply" id="apply-btn" ${canApply ? '' : 'disabled'}>Apply</button>
    <button class="btn-edit" id="edit-btn">Edit</button>
    <button class="btn-skip" id="skip-btn">Skip</button>
  `;

  $('apply-btn').addEventListener('click', async () => {
    if (!comment.proposal || !comment.proposal.actions.length) return;

    showLoading('Applying changes...');

    for (const action of comment.proposal.actions) {
      try {
        const result = await requestFromPlugin<Extract<PluginMessage, { type: 'action-executed' }>>(
          { type: 'execute-action', action },
          'action-executed',
          undefined,
          10000
        );

        if (!result.success) {
          hideLoading();
          showToast(`Failed: ${result.error || 'Unknown error'}`, 'error');
          return;
        }
      } catch {
        hideLoading();
        showToast('Action timed out. Please try again.', 'error');
        return;
      }
    }

    hideLoading();
    comment.status = 'applied';
    showToast('Changes applied!', 'success');
    renderFocusProposal(comment);
    renderFocusActions(comment);
  });

  $('edit-btn').addEventListener('click', () => {
    show('edit-modal');
    (document.getElementById('edit-textarea') as HTMLTextAreaElement).value = '';
    (document.getElementById('edit-textarea') as HTMLTextAreaElement).focus();
  });

  $('skip-btn').addEventListener('click', () => {
    comment.status = 'skipped';
    showToast('Comment skipped', 'info');
    renderFocusProposal(comment);
    renderFocusActions(comment);
  });
}

// ── Edit Modal ─────────────────────────────────────────────────
function initEditModal() {
  $('edit-cancel-btn').addEventListener('click', () => hide('edit-modal'));

  $('edit-submit-btn').addEventListener('click', async () => {
    const userEdit = (document.getElementById('edit-textarea') as HTMLTextAreaElement).value.trim();
    if (!userEdit) return;

    hide('edit-modal');

    const comment = state.comments.find((c) => c.id === state.selectedCommentId);
    if (!comment) return;

    comment.status = 'pending';
    comment.proposal = null;

    const proposalEl = $('focus-proposal');
    proposalEl.innerHTML = `
      <h3>Proposed Changes</h3>
      <div class="proposal-loading"><span class="spinner-inline"></span> Re-analyzing with your input...</div>
    `;

    try {
      let nodeInfo: NodeInfo | null = null;
      if (comment.nodeId) {
        try {
          const msg = await requestFromPlugin<Extract<PluginMessage, { type: 'node-info' }>>(
            { type: 'get-node-info', nodeId: comment.nodeId },
            'node-info'
          );
          nodeInfo = msg.info;
        } catch {
          nodeInfo = null;
        }
      }

      const proposal = await reAnalyzeComment(
        state.claudeApiKey,
        comment.message,
        userEdit,
        comment.nodeId || '',
        nodeInfo
      );

      comment.proposal = proposal;
      comment.commentType = proposal.commentType;
      comment.status =
        proposal.actions.length === 0 ? 'needs_clarification' : 'proposal_ready';

      renderFocusProposal(comment);
      renderFocusActions(comment);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      proposalEl.innerHTML = `
        <h3>Proposed Changes</h3>
        <div class="proposal-error">Re-analysis failed: ${escapeHtml(message)}</div>
      `;
    }
  });
}

// ── Load Comments ──────────────────────────────────────────────
async function loadComments() {
  showLoading('Loading comments...');

  try {
    if (!state.fileKey) {
      try {
        const msg = await requestFromPlugin<Extract<PluginMessage, { type: 'file-key' }>>(
          { type: 'get-file-key' },
          'file-key',
          undefined,
          3000
        );
        state.fileKey = msg.fileKey;
      } catch {
        throw new Error('Could not get file key. Make sure the file is saved to Figma.');
      }
    }

    if (!state.fileKey) {
      throw new Error('Could not get file key. Make sure the file is saved to Figma.');
    }

    const raw = await fetchComments(state.fileKey, state.figmaToken);
    state.comments = transformComments(raw);

    hideLoading();
    showView('inbox');
    renderInbox();

    classifyCommentsInBackground();
  } catch (err: unknown) {
    hideLoading();
    const message = err instanceof Error ? err.message : String(err);
    showToast(`Error: ${message}`, 'error');

    if (message.includes('403') || message.includes('401')) {
      showView('setup');
      show('setup-error');
      $('setup-error').textContent = 'Invalid Figma token. Please check and try again.';
    }
  }
}

async function classifyCommentsInBackground() {
  for (const comment of state.comments) {
    if (comment.status !== 'pending') continue;

    try {
      const type = await classifyComment(state.claudeApiKey, comment.message);
      comment.commentType = type;
      if (state.view === 'inbox') {
        renderInbox();
      }
    } catch {
      // Silently skip
    }
  }
}

// ── Navigation ─────────────────────────────────────────────────
function initNavigation() {
  $('back-btn').addEventListener('click', () => {
    state.selectedCommentId = null;
    showView('inbox');
    renderInbox();
  });

  $('refresh-btn').addEventListener('click', () => loadComments());
  $('empty-refresh-btn').addEventListener('click', () => loadComments());

  $('settings-btn').addEventListener('click', () => {
    showView('setup');
    (document.getElementById('claude-key') as HTMLInputElement).value = state.claudeApiKey;
    (document.getElementById('figma-token') as HTMLInputElement).value = state.figmaToken;
  });
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  // Set up UI event listeners first (safe, synchronous)
  try {
    initSetup();
    initNavigation();
    initEditModal();
  } catch (err) {
    console.error('[AI Comment Assistant] UI init error:', err);
  }

  // Listen for file key messages from plugin
  window.addEventListener('message', (event) => {
    const msg = event.data?.pluginMessage;
    if (msg && msg.type === 'file-key') {
      state.fileKey = msg.fileKey;
    }
  });

  // Try to load stored keys (with timeouts to prevent hanging)
  try {
    const claudeKeyMsg = await requestFromPlugin<Extract<PluginMessage, { type: 'store-value' }>>(
      { type: 'store-get', key: 'claude-api-key' },
      'store-value',
      'claude-api-key',
      3000
    );

    const figmaTokenMsg = await requestFromPlugin<Extract<PluginMessage, { type: 'store-value' }>>(
      { type: 'store-get', key: 'figma-token' },
      'store-value',
      'figma-token',
      3000
    );

    if (claudeKeyMsg.value && figmaTokenMsg.value) {
      state.claudeApiKey = claudeKeyMsg.value;
      state.figmaToken = figmaTokenMsg.value;
      await loadComments();
    } else {
      showView('setup');
    }
  } catch {
    // Timeout or error — just show setup screen
    console.log('[AI Comment Assistant] No stored keys found, showing setup.');
    showView('setup');
  }
}

// Start
init();
