const $ = id => document.getElementById(id);
const tokenKey = 'agent-relay-token';
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) { sessionStorage.setItem(tokenKey, fragment.get('token')); history.replaceState(null, '', location.pathname); }
let token = sessionStorage.getItem(tokenKey), tasks = [], selected = null, detail = null, filter = 'all', connected = false, polling = false, historySignature = '';
const attentionStates = new Set(['needs_attention', 'limited', 'failed', 'interrupted']);
const labels = { running: 'Running', queued: 'Queued', completed: 'Completed', failed: 'Failed', needs_attention: 'Needs attention', limited: 'Usage limit', interrupted: 'Interrupted', cancelled: 'Stopped', draft: 'Ready to start' };
const agentNames = { claude: 'Claude Code', codex: 'Codex' };
const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text != null) element.textContent = text; return element; };
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
async function api(route, data) {
  const response = await fetch(`/api${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token || ''}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) connected = false; throw new Error(result.error || 'Request failed.'); }
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
    card.setAttribute('aria-pressed', String(task.id === selected)); card.append(node('h3', '', task.title), node('div', 'project', basename(task.project)));
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
  selected = id; historySignature = ''; $('run-note').value = ''; renderTasks();
  await refreshDetail(true);
}
function renderHistory(runs) {
  const signature = JSON.stringify(runs.map(r => [r.id, r.state, r.summary, r.events.at(-1)?.id]));
  if (signature === historySignature) return; historySignature = signature;
  const expanded = new Set([...$('run-history').querySelectorAll('details[open]')].map(d => d.dataset.run));
  $('run-history').replaceChildren();
  if (!runs.length) { $('run-history').append(node('p', 'no-runs', 'Ready when you are. Choose an agent and start the first run.')); return; }
  for (const run of runs) {
    const article = node('section', 'run'), head = node('div', 'run-head');
    head.append(node('span', `avatar ${run.agent}`, run.agent === 'claude' ? 'C' : '↗'), node('strong', '', agentNames[run.agent]), badge(run.state));
    head.append(node('time', '', new Date(run.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    article.append(head, node('p', 'run-summary', run.summary || (run.state === 'queued' ? 'Waiting for a slot or for another run in this project to finish.' : run.state === 'running' ? 'Agent is working. Live steps appear below.' : 'No response text was recorded.')));
    const events = node('details'); events.dataset.run = run.id; events.open = expanded.has(run.id); events.append(node('summary', '', `${run.events.length} recent events · ${run.permission}${run.session_id ? ' · session saved' : ''}`));
    const log = node('div', 'events');
    for (const event of run.events) { const entry = node('div', 'event'); entry.append(node('div', 'event-kind', event.kind), node('pre', '', event.text)); log.append(entry); }
    events.append(log); article.append(events); $('run-history').append(article);
  }
}
function updateActions() {
  if (!detail) return;
  const latest = detail.runs.at(-1), busy = detail.runs.some(r => ['queued', 'running'].includes(r.state)), agent = $('run-agent').value;
  $('run-button').disabled = busy; $('preview').disabled = busy; $('stop-run').hidden = !busy;
  $('run-button').textContent = latest ? `${latest.agent === agent && latest.session_id ? 'Resume' : 'Continue with'} ${agent === 'claude' ? 'Claude' : 'Codex'} →` : `Start ${agent === 'claude' ? 'Claude' : 'Codex'} →`;
  $('run-mode').textContent = busy ? 'Run in progress' : latest && latest.agent !== agent ? 'Shared context handoff' : latest?.session_id ? 'Saved session' : 'New session';
  $('permission-note').textContent = $('run-permission').value === 'read-only' ? 'Reads project files. Permission requests are surfaced for your review.' : 'Uses provider edit permissions. Denied actions appear in the run history for review.';
}
async function refreshDetail(initial = false) {
  if (!selected) return;
  const id = selected; const result = await api(`/tasks/${id}`); if (selected !== id) return; detail = result;
  $('empty-detail').hidden = true; $('task-detail').hidden = false;
  $('detail-title').textContent = detail.task.title; $('detail-project').textContent = basename(detail.task.project); $('detail-project').title = detail.task.project;
  $('detail-status').replaceChildren(badge(detail.runs.at(-1)?.state)); $('original-request').textContent = detail.task.original_prompt;
  if (initial) { $('shared-context').value = detail.task.context; const last = detail.runs.at(-1); if (last) { $('run-agent').value = last.agent; $('run-permission').value = last.permission; $('run-model').value = last.model; } }
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
function openNew() { $('new-error').textContent = ''; $('new-dialog').showModal(); }
$('new-task').addEventListener('click', openNew); $('first-task').addEventListener('click', openNew);
$('close-new').addEventListener('click', () => $('new-dialog').close()); $('close-preview').addEventListener('click', () => $('preview-dialog').close());
$('all-tasks').addEventListener('click', () => { filter = 'all'; renderTasks(); }); $('attention-filter').addEventListener('click', () => { filter = 'attention'; renderTasks(); }); $('search').addEventListener('input', renderTasks);
let creating = false;
async function createTask(start) {
  if (creating || !$('new-form').reportValidity()) return; creating = true;
  const buttons = [...$('new-form').querySelectorAll('button')]; buttons.forEach(b => b.disabled = true);
  try {
    const { task } = await api('/tasks', { title: $('new-title').value, project: $('new-project').value, prompt: $('new-prompt').value, context: $('new-context').value });
    $('new-dialog').close(); $('new-form').reset();
    await select(task.id);
    if (start) { $('run-agent').value = createTask.runOptions.agent; $('run-permission').value = createTask.runOptions.permission; await api(`/tasks/${task.id}/runs`, createTask.runOptions); }
    await refresh();
  } catch (error) { if ($('new-dialog').open) $('new-error').textContent = error.message; else { notice(`Task saved. ${error.message}`); await refresh(); } }
  finally { creating = false; buttons.forEach(b => b.disabled = false); }
}
$('new-form').addEventListener('submit', event => { event.preventDefault(); createTask.runOptions = { agent: $('new-agent').value, permission: $('new-permission').value }; void createTask(true); });
$('create-only').addEventListener('click', () => void createTask(false));
$('save-context').addEventListener('click', () => action(async () => { await api(`/tasks/${selected}/context`, { context: $('shared-context').value }); notice('Shared context saved. It will be included in the next run.'); }));
$('continue-form').addEventListener('submit', event => { event.preventDefault(); $('run-button').disabled = true; void action(async () => { await api(`/tasks/${selected}/runs`, options()); $('run-note').value = ''; await refresh(); }).finally(updateActions); });
$('preview').addEventListener('click', () => action(async () => { const result = await api(`/tasks/${selected}/preview`, options()); $('preview-mode').textContent = result.session_id ? 'Resumes the saved provider session and supplies this context.' : 'Starts a new provider session with this context.'; $('preview-text').textContent = result.prompt; $('preview-dialog').showModal(); }));
$('stop-run').addEventListener('click', () => action(async () => { const run = detail.runs.find(r => ['queued', 'running'].includes(r.state)); if (run) await api(`/runs/${run.id}/stop`, {}); await refresh(); }));
$('run-agent').addEventListener('change', updateActions); $('run-permission').addEventListener('change', updateActions);
$('check-providers').addEventListener('click', () => action(async () => { renderProviders((await api('/doctor', {})).providers); }));
if (!token) { notice('Open the private localhost URL printed by agent-relay in your terminal to connect.'); $('connection').textContent = 'Private link needed'; }
else await action(async () => { const status = await api('/status'); connected = true; renderProviders(status.providers); $('queue-note').textContent = `${status.concurrency} run slots · One run per folder`; await refresh(); });
setInterval(refresh, 2000);
