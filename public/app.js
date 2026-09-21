const $ = id => document.getElementById(id);
const tokenKey = 'agent-relay-token';
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) { sessionStorage.setItem(tokenKey, fragment.get('token')); history.replaceState(null, '', location.pathname); }
let token = sessionStorage.getItem(tokenKey), tasks = [], selected = null, detail = null, filter = 'all', connected = false, polling = false, historySignature = '';
const contextDrafts = new Map();
const uiKey = 'agent-relay-chat-drafts';
let uiState; try { uiState = JSON.parse(sessionStorage.getItem(uiKey)) || { chats: {} }; } catch { uiState = { chats: {} }; }
let composerAgent = 'claude';
function persistUi() { try { sessionStorage.setItem(uiKey, JSON.stringify(uiState)); } catch {} }
function rememberComposer() {
  if (!selected || detail?.task.id !== selected) return;
  const saved = uiState.chats[selected] ||= { models: {} };
  saved.note = $('run-note').value; saved.agent = $('run-agent').value; saved.permission = $('run-permission').value;
  saved.models[composerAgent] = $('run-model').value; uiState.selected = selected; persistUi();
}
let detailRequest = 0;
const attentionStates = new Set(['needs_attention', 'limited', 'failed', 'interrupted']);
const labels = { running: 'Running', queued: 'Queued', completed: 'Completed', failed: 'Failed', needs_attention: 'Needs attention', limited: 'Usage limit', interrupted: 'Interrupted', cancelled: 'Stopped', draft: 'Ready to start' };
const agentNames = { claude: 'Claude Code', codex: 'Codex' };
const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text != null) element.textContent = text; return element; };
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(route, data) {
  const response = await fetch(`/api${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token || ''}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) connected = false; const error = new Error(result.error || 'Request failed.'); error.status = response.status; throw error; }
  return result;
}
function badge(state) { return node('span', `status ${state || 'draft'}`, labels[state || 'draft'] || state); }
function basename(value) { return value.split(/[\\/]/).filter(Boolean).at(-1) || value; }
function renderTasks() {
  $('total').textContent = tasks.length; $('sidebar-count').textContent = tasks.length;
  $('working').textContent = tasks.filter(t => ['running', 'queued'].includes(t.state)).length;
  $('attention').textContent = $('attention-count').textContent = tasks.filter(t => attentionStates.has(t.state)).length;
  $('completed').textContent = tasks.filter(t => t.state === 'completed').length;
  $('list-heading').textContent = filter === 'all' ? 'All tasks' : 'Needs attention';
  $('all-tasks').classList.toggle('active', filter === 'all'); $('attention-filter').classList.toggle('active', filter !== 'all');
  const query = $('search').value.toLowerCase();
  const visible = tasks.filter(t => (filter === 'all' || attentionStates.has(t.state)) && `${t.title} ${t.project}`.toLowerCase().includes(query));
  const list = $('task-list'); list.replaceChildren();
  if (!visible.length) list.append(node('p', 'empty-list', tasks.length ? 'No tasks match this view.' : 'Your next project starts here.'));
  for (const task of visible) {
    const card = node('button', `task-card${task.id === selected ? ' selected' : ''}`);
    card.setAttribute('aria-pressed', String(task.id === selected)); card.append(node('h3', '', task.title), node('div', 'project', task.project ? basename(task.project) : 'General chat'));
    const bottom = node('div', 'card-bottom'); bottom.append(badge(task.state), node('span', '', agentNames[task.agent] || 'No agent yet')); card.append(bottom);
    card.addEventListener('click', () => action(() => select(task.id))); list.append(card);
  }
}
function renderProviders(providers) {
  $('providers').replaceChildren();
  for (const provider of providers) {
    const row = node('div', 'provider'); row.append(node('span', `provider-avatar ${provider.agent}`, provider.agent === 'claude' ? 'C' : '↗'));
    const description = node('div'); description.append(node('div', 'provider-name', agentNames[provider.agent]), node('div', 'provider-version', provider.available ? (provider.authenticated === false ? 'Sign in to CLI' : provider.version) : 'CLI not found')); row.append(description); $('providers').append(row);
    row.title = provider.path || provider.error;
  }
}
async function select(id) {
  rememberComposer();
  selected = id; uiState.selected = id; persistUi(); detail = null; historySignature = '';
  $('run-button').disabled = $('preview').disabled = true; renderTasks();
  await refreshDetail(true);
}
function renderHistory(runs) {
  const signature = JSON.stringify(runs.map(r => [r.id, r.state, r.summary, r.usage_json, r.events.at(-1)?.id]));
  if (signature === historySignature) return; historySignature = signature;
  const history = $('run-history'), scroll = history.scrollTop, follow = history.scrollHeight - scroll - history.clientHeight < 80;
  const expanded = new Set([...$('run-history').querySelectorAll('details[open]')].map(d => d.dataset.run));
  $('run-history').replaceChildren();
  const chat = detail?.task.kind === 'chat'; $('run-history').classList.toggle('conversation', chat);
  if (!runs.length) { $('run-history').append(node('p', 'no-runs', detail?.task.kind === 'chat' ? 'Send a message below. You can switch providers between replies.' : 'Ready when you are. Choose an agent and start the first run.')); return; }
  const previousUsage = new Map();
  for (const run of runs) {
    if (chat) { const message = node('section', 'user-message'); message.append(node('strong', '', 'You'), node('p', '', run.instruction || detail.task.original_prompt)); $('run-history').append(message); }
    const article = node('section', 'run'), head = node('div', 'run-head');
    head.append(node('span', `avatar ${run.agent}`, run.agent === 'claude' ? 'C' : '↗'), node('strong', '', agentNames[run.agent]), badge(run.state));
    head.append(node('time', '', new Date(run.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    article.append(head, node('p', 'run-summary', run.summary || (run.state === 'queued' ? 'Waiting for a slot or for another run in this project to finish.' : run.state === 'running' ? 'Agent is working. Live steps appear below.' : 'No response text was recorded.')));
    if (run.usage) {
      let u = run.usage, scope = '';
      if (u.scope === 'session') {
        const previous = previousUsage.get(run.session_id);
        if (previous && u.input >= previous.input && u.output >= previous.output) u = { ...u, input: u.input - previous.input, output: u.output - previous.output, cached: Math.max(0, (u.cached || 0) - (previous.cached || 0)) };
        else scope = ' · session total';
        previousUsage.set(run.session_id, run.usage);
      }
      const metric = node('p', 'usage-line', `${formatTokens(u.input + u.output)} tokens · ${formatTokens(u.input)} in / ${formatTokens(u.output)} out${scope}`);
      metric.title = `Cached input: ${u.cached ?? 'unreported'}. Input includes cached tokens. Token volume does not equal plan usage percentage.`;
      article.append(metric);
    }
    const events = node('details'); events.dataset.run = run.id; events.open = expanded.has(run.id); events.append(node('summary', '', `${run.events.length} recent events · ${run.permission}${run.session_id ? ' · session saved' : ''}`));
    const log = node('div', 'events');
    for (const event of run.events) { const entry = node('div', 'event'); entry.append(node('div', 'event-kind', event.kind), node('pre', '', event.text)); log.append(entry); }
    events.append(log); article.append(events); $('run-history').append(article);
  }
  history.scrollTop = follow ? history.scrollHeight : scroll;
}
function updateActions() {
  if (!detail) return;
  const latest = detail.runs.at(-1), busy = detail.runs.some(r => ['queued', 'running'].includes(r.state)), agent = $('run-agent').value;
  $('run-button').disabled = busy; $('preview').disabled = busy; $('stop-run').hidden = !busy;
  $('run-button').textContent = latest ? `${latest.agent === agent && latest.session_id ? 'Resume' : 'Continue with'} ${agent === 'claude' ? 'Claude' : 'Codex'} →` : `Start ${agent === 'claude' ? 'Claude' : 'Codex'} →`;
  $('run-mode').textContent = busy ? 'Run in progress' : latest && latest.agent !== agent ? 'Shared context handoff' : latest?.session_id ? 'Saved session' : 'New session';
  if (detail.task.kind === 'chat') {
    $('run-button').textContent = `Send to ${agent === 'claude' ? 'Claude' : 'Codex'} →`;
    $('run-note').placeholder = 'Message Claude or Codex…';
    $('run-mode').textContent = busy ? 'Reply in progress' : latest?.agent !== agent && latest ? 'Share conversation on switch' : 'Continue conversation';
  } else $('run-note').placeholder = 'What should happen next?';
  $('compact-chat').hidden = detail.task.kind !== 'chat';
  $('compact-chat').disabled = busy || !detail.runs.length;
  $('checkpoint-note').hidden = !detail.checkpoint;
  $('checkpoint-note').textContent = detail.checkpoint ? 'Compacted: future replies use your summary. Earlier messages are kept below.' : '';
  $('run-permission').disabled = !detail.task.project;
  $('permission-note').textContent = !detail.task.project ? 'General chat. Enter sends; Shift+Enter adds a line.' : $('run-permission').value === 'read-only' ? 'Reads project files. Permission requests are surfaced for your review.' : 'Uses provider edit permissions. Denied actions appear in the run history for review.';
}
function renderContext() {
  const edit = contextDrafts.get(selected); if (!edit) return;
  if ($('shared-context').value !== edit.draft) $('shared-context').value = edit.draft;
  const conflict = edit.base !== edit.latest && edit.draft !== edit.base;
  $('context-conflict').hidden = !conflict;
  $('latest-context').textContent = edit.latest || '(Empty context)';
  $('save-context').disabled = conflict || edit.saving;
  $('save-merged-context').disabled = edit.saving;
  $('use-latest-context').disabled = edit.saving;
}
function syncContext(id, latest) {
  let edit = contextDrafts.get(id);
  if (!edit) { edit = { base: latest, draft: latest, latest, saving: false }; contextDrafts.set(id, edit); }
  else {
    if (edit.draft === edit.base || edit.draft === latest) edit.base = edit.draft = latest;
    edit.latest = latest;
  }
  renderContext();
}
async function saveContext(merged = false) {
  const id = selected, edit = contextDrafts.get(id);
  if (!edit || edit.saving) return;
  const submitted = edit.draft;
  edit.saving = true; renderContext();
  try {
    const result = await api(`/tasks/${id}/context`, { context: submitted, expected_context: merged ? edit.latest : edit.base });
    edit.base = edit.latest = result.task.context;
    if (edit.draft === submitted) edit.draft = result.task.context;
    if (selected === id) notice('Shared context saved. It will be included in the next run.');
    await refreshDetail();
  } catch (error) {
    if (error.status === 409 && selected === id) await refreshDetail();
    throw error;
  } finally { edit.saving = false; renderContext(); }
}
async function refreshDetail(initial = false) {
  if (!selected) return;
  const id = selected, request = ++detailRequest;
  const result = await api(`/tasks/${id}`); if (selected !== id || request !== detailRequest) return;
  const initializeControls = initial || detail?.task.id !== id; detail = result;
  $('empty-detail').hidden = true; $('task-detail').hidden = false;
  $('detail-title').textContent = detail.task.title; $('detail-project').textContent = detail.task.project ? basename(detail.task.project) : 'General chat'; $('detail-project').title = detail.task.project;
  $('detail-status').replaceChildren(badge(detail.runs.at(-1)?.state)); $('original-request').textContent = detail.task.original_prompt;
  $('history-heading').textContent = detail.task.kind === 'chat' ? 'Conversation' : 'Run history';
  $('history-caption').textContent = detail.task.kind === 'chat' ? 'Choose a provider for each message' : 'Recorded from provider output';
  syncContext(id, detail.task.context);
  if (initializeControls) {
    const last = detail.runs.at(-1);
    const saved = uiState.chats[id];
    composerAgent = saved?.agent || last?.agent || 'claude';
    $('run-agent').value = composerAgent;
    $('run-permission').value = !detail.task.project ? 'read-only' : saved?.permission || last?.permission || 'read-only';
    $('run-model').value = saved?.models?.[composerAgent] ?? detail.runs.findLast(r => r.agent === composerAgent)?.model ?? '';
    $('run-note').value = saved?.note || '';
  }
  $('chat-usage').textContent = (detail.usage || []).filter(u => u.reported).map(u => `${agentNames[u.agent]}: ${formatTokens(u.total)} tokens in this conversation`).join(' · ');
  renderHistory(detail.runs); updateActions();
}
async function refresh() {
  if (!connected || polling) return; polling = true;
  try { tasks = (await api('/tasks')).tasks; renderTasks(); await refreshDetail(); $('connection').textContent = 'Connected locally'; }
  catch (error) { $('connection').textContent = 'Disconnected'; notice(error.message); }
  finally { polling = false; }
}
function options() { return { agent: $('run-agent').value, permission: $('run-permission').value, model: $('run-model').value.trim(), note: $('run-note').value }; }
async function action(fn) { try { notice(); await fn(); } catch (error) { notice(error.message); } }
function newMode() {
  const chat = $('new-kind').value === 'chat';
  $('new-project').required = !chat; $('new-prompt').required = !chat; $('new-title').required = !chat;
  $('project-optional').hidden = !chat; $('prompt-optional').hidden = !chat;
}
function openNew() { $('new-error').textContent = ''; newMode(); $('new-dialog').showModal(); }
$('new-kind').addEventListener('change', newMode);
$('new-task').addEventListener('click', openNew); $('first-task').addEventListener('click', openNew);
$('close-new').addEventListener('click', () => $('new-dialog').close()); $('close-preview').addEventListener('click', () => $('preview-dialog').close());
$('all-tasks').addEventListener('click', () => { filter = 'all'; renderTasks(); }); $('attention-filter').addEventListener('click', () => { filter = 'attention'; renderTasks(); }); $('search').addEventListener('input', renderTasks);
let creating = false;
async function createTask(start) {
  if (creating || !$('new-form').reportValidity()) return; creating = true;
  const kind = $('new-kind').value, prompt = $('new-prompt').value;
  const runOptions = { agent: $('new-agent').value, permission: kind === 'chat' && !$('new-project').value.trim() ? 'read-only' : $('new-permission').value };
  const buttons = [...$('new-form').querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
  try {
    const { task } = await api('/tasks', { kind, title: $('new-title').value.trim() || prompt.trim().slice(0, 70) || 'New chat', project: $('new-project').value.trim(), prompt, context: $('new-context').value });
    $('new-dialog').close(); $('new-form').reset();
    await select(task.id);
    $('run-agent').value = runOptions.agent; $('run-permission').value = runOptions.permission; $('run-model').value = '';
    composerAgent = runOptions.agent; rememberComposer(); updateActions();
    if (start && (kind !== 'chat' || prompt.trim())) await api(`/tasks/${task.id}/runs`, runOptions);
    await refresh(); $('run-note').focus();
  } catch (error) { if ($('new-dialog').open) $('new-error').textContent = error.message; else { notice(`Task saved. ${error.message}`); await refresh(); } }
  finally { creating = false; buttons.forEach(b => b.disabled = false); }
}
$('new-form').addEventListener('submit', event => { event.preventDefault(); void createTask(true); });
$('create-only').addEventListener('click', () => void createTask(false));
$('shared-context').addEventListener('input', () => { const edit = contextDrafts.get(selected); if (edit) { edit.draft = $('shared-context').value; renderContext(); } });
$('save-context').addEventListener('click', () => action(() => saveContext()));
$('save-merged-context').addEventListener('click', () => action(() => saveContext(true)));
$('use-latest-context').addEventListener('click', () => { const edit = contextDrafts.get(selected); if (edit) { edit.base = edit.draft = edit.latest; renderContext(); } });
$('run-note').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && detail?.task.kind === 'chat') { event.preventDefault(); if (!$('run-button').disabled) $('continue-form').requestSubmit(); } });
$('run-note').addEventListener('input', rememberComposer); $('run-model').addEventListener('input', rememberComposer);
$('continue-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($('run-note').value.trim() === '/compact') { openCompact(); return; }
  const id = selected, submitted = options(); rememberComposer(); $('run-button').disabled = true;
  void action(async () => {
    await api(`/tasks/${id}/runs`, submitted);
    const saved = uiState.chats[id];
    if (saved?.note === submitted.note) saved.note = '';
    if (selected === id && $('run-note').value === submitted.note) $('run-note').value = '';
    persistUi(); await refresh();
  }).finally(updateActions);
});
$('preview').addEventListener('click', () => action(async () => { const result = await api(`/tasks/${selected}/preview`, options()); $('preview-mode').textContent = result.session_id ? 'Resumes the saved provider session and supplies this context.' : 'Starts a new provider session with this context.'; $('preview-text').textContent = result.prompt; $('preview-dialog').showModal(); }));
$('stop-run').addEventListener('click', () => action(async () => { const run = detail.runs.find(r => ['queued', 'running'].includes(r.state)); if (run) await api(`/runs/${run.id}/stop`, {}); await refresh(); }));
$('run-agent').addEventListener('change', () => {
  rememberComposer(); composerAgent = $('run-agent').value;
  $('run-model').value = uiState.chats[selected]?.models?.[composerAgent] ?? detail?.runs.findLast(r => r.agent === composerAgent)?.model ?? '';
  rememberComposer(); updateActions();
});
$('run-permission').addEventListener('change', () => { rememberComposer(); updateActions(); });
$('check-providers').addEventListener('click', () => action(async () => { renderProviders((await api('/doctor', {})).providers); }));


let compactTarget;
function openCompact() {
  if (detail?.task.kind !== 'chat' || !detail.runs.length || detail.runs.some(r => ['running','queued'].includes(r.state))) { notice('Finish a chat reply before compacting.'); return; }
  compactTarget = { id: selected, expected_run: detail.runs.at(-1).id, expected_checkpoint: detail.checkpoint?.created_at || null };
  $('compact-summary').value = detail.checkpoint?.summary || detail.task.context;
  $('compact-error').textContent = ''; $('confirm-compact').disabled = !$('compact-summary').value.trim();
  $('compact-dialog').showModal(); $('compact-summary').focus();
}
$('compact-chat').addEventListener('click', openCompact);
$('close-compact').addEventListener('click', () => $('compact-dialog').close());
$('compact-summary').addEventListener('input', () => { $('confirm-compact').disabled = !$('compact-summary').value.trim(); });
$('confirm-compact').addEventListener('click', async () => {
  $('confirm-compact').disabled = true;
  try {
    await api(`/tasks/${compactTarget.id}/compact`, { ...compactTarget, summary: $('compact-summary').value });
    $('compact-dialog').close();
    if (selected === compactTarget.id && $('run-note').value.trim() === '/compact') { $('run-note').value = ''; rememberComposer(); }
    await refreshDetail(); notice('Chat compacted without a model call. Your next reply starts a fresh provider session.');
  } catch (error) { $('compact-error').textContent = error.message; }
  finally { $('confirm-compact').disabled = !$('compact-summary').value.trim(); }
});

function formatTokens(value) { return new Intl.NumberFormat(undefined, { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value); }
$('usage-button').addEventListener('click', () => action(async () => {
  const data = await api('/usage'); $('usage-totals').replaceChildren();
  for (const u of data.providers) {
    const card = node('section', 'usage-card');
    card.append(node('h3', '', agentNames[u.agent]), node('strong', '', u.reported ? formatTokens(u.total) + ' tokens' : 'No usage recorded yet'),
      node('p', '', `${formatTokens(u.input)} input · ${formatTokens(u.output)} output · ${formatTokens(u.cached)} cached input`));
    if (u.costUsd !== null) card.append(node('p', '', `CLI cost estimate: USD ${u.costUsd.toFixed(4)}. This is not a subscription charge.`));
    if (u.unreported) card.append(node('p', 'muted', `${u.unreported} replies have no reported usage. Older runs were not measured.`));
    $('usage-totals').append(card);
  }
  $('usage-dialog').showModal();
}));
$('close-usage').addEventListener('click', () => $('usage-dialog').close());
$('refresh-limits').addEventListener('click', () => action(async () => {
  $('refresh-limits').disabled = true; $('account-limits').textContent = 'Checking…';
  try {
    const data = await api('/limits', {}); $('account-limits').replaceChildren();
    for (const window of data.windows) {
      const row = node('div', 'limit-row'), bar = node('progress'); bar.max = 100; bar.value = window.usedPercent;
      row.append(node('p', '', `${window.name}: ${window.usedPercent}% used`), bar,
        node('small', '', window.resetsAt ? 'Resets ' + new Date(window.resetsAt * 1000).toLocaleString() : 'Reset time unavailable'));
      $('account-limits').append(row);
    }
    if (!data.windows.length) $('account-limits').textContent = 'No plan limits returned for this CLI login.';
  } catch (error) { $('account-limits').textContent = error.message; }
  finally { $('refresh-limits').disabled = false; }
}));

if (!token) { notice('Open the private localhost URL printed by agent-relay in your terminal to connect.'); $('connection').textContent = 'Private link needed'; }
else await action(async () => { const status = await api('/status'); connected = true; renderProviders(status.providers); $('queue-note').textContent = `${status.concurrency} run slots · One run per folder`; await refresh(); const initialTask = fragment.get('task') || uiState.selected; if (initialTask && tasks.some(t => t.id === initialTask)) await select(initialTask); });
setInterval(refresh, 2000);
