// solidcraft-triage frontend glue: fetches GitHub issues, drives the WASM engine.
const $ = id => document.getElementById(id);
const state = { wasm: null, mem: null, labels: new Set(), offset: 0, limit: 200, loaded: false };

// ---------- wasm plumbing ----------
function readOut(ptr) {
  const dv = new DataView(state.mem.buffer);
  const len = dv.getUint32(ptr, true);
  const bytes = new Uint8Array(state.mem.buffer, ptr + 4, len);
  return JSON.parse(new TextDecoder().decode(bytes));
}
function call(fn, obj) {
  const ex = state.wasm.exports;
  const enc = new TextEncoder().encode(JSON.stringify(obj));
  const ptr = ex.alloc(enc.length);
  new Uint8Array(state.mem.buffer, ptr, enc.length).set(enc);
  const out = ex[fn](ptr, enc.length);
  ex.dealloc(ptr, enc.length);
  return readOut(out);
}
async function initWasm() {
  const { instance } = await WebAssembly.instantiateStreaming(fetch('triage.wasm'), {});
  state.wasm = instance; state.mem = instance.exports.memory;
  $('status').textContent = 'wasm: ready';
}

// ---------- github fetch ----------
async function gh(url, token) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(url, { headers: h });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}
// GraphQL path: cursor pagination, no 1000-item cap (token required).
const GQL = `query($q:String!,$cur:String){search(type:ISSUE,first:100,query:$q,after:$cur){
 pageInfo{hasNextPage endCursor} nodes{... on Issue{number title state stateReason url
 labels(first:30){nodes{name}} comments{totalCount} createdAt updatedAt closedAt
 author{login}}}}`;
async function loadIssuesGQL(repo, token) {
  let cur = null, total = 0;
  for (;;) {
    const r = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: GQL, variables: { q: `repo:${repo} is:issue`, cur } }),
    });
    if (!r.ok) throw new Error(`graphql ${r.status} — ${await r.text()}`);
    const j = await r.json();
    if (j.errors) throw new Error('graphql: ' + j.errors[0].message);
    const s = j.data.search;
    const mapped = s.nodes.filter(Boolean).map(n => ({
      number: n.number, title: n.title, state: n.state.toLowerCase(),
      state_reason: n.stateReason ? n.stateReason.toLowerCase() : null,
      labels: (n.labels ? n.labels.nodes : []).map(l => ({ name: l.name })),
      comments: n.comments.totalCount, created_at: n.createdAt, updated_at: n.updatedAt,
      closed_at: n.closedAt, user: n.author, html_url: n.url,
    }));
    const res = call('triage_load', mapped);
    if (res.error) throw new Error('wasm parse: ' + res.error);
    total += s.nodes.length;
    $('status').textContent = `fetching… ${total} (${res.total} issues)`;
    if (!s.pageInfo.hasNextPage) break;
    cur = s.pageInfo.endCursor;
  }
  return total;
}

async function loadIssues() {
  const repo = $('repo').value.trim();
  const token = $('token').value.trim() || localStorage.getItem('sct-token') || '';
  if (token) localStorage.setItem('sct-token', token);
  state.wasm.exports.triage_reset();
  state.loaded = false; state.offset = 0; state.labels.clear();
  $('load').disabled = true;
  let total = 0;
  try {
    if (token) {
      total = await loadIssuesGQL(repo, token);
    } else {
      let page = 1;
      for (;;) {
        const batch = await gh(`https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}`, token);
        if (!Array.isArray(batch) || batch.length === 0) break;
        const res = call('triage_load', batch);
        if (res.error) throw new Error('wasm parse: ' + res.error);
        total += batch.length;
        $('status').textContent = `fetching… ${total} (${res.total} issues)`;
        if (batch.length < 100 || page >= 10) break; // REST page cap is 10 for large repos
        page++;
      }
      if (total >= 1000) $('status').textContent = 'first 1000 only — paste a token for full history';
    }
    state.loaded = true;
    $('status').textContent = `loaded ${total} items`;
    refresh();
  } catch (e) {
    if (total > 0) { // keep what we got, note the error
      state.loaded = true; refresh();
      $('status').textContent = `partial: ${e.message}`;
    } else {
      $('status').textContent = '';
      $('rows').innerHTML = `<tr><td colspan="7" class="err">${e.message} (rate limit? paste a token)</td></tr>`;
    }
  } finally { $('load').disabled = false; }
}

// ---------- query + render ----------
function query() {
  return call('triage_query', {
    q: $('q').value, labels: [...state.labels], not_labels: [],
    state: $('state').value, reason: $('reason').value,
    sort: $('sort').value, desc: true, offset: state.offset, limit: state.limit,
  });
}
const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const lblClass = l => /dup/i.test(l) ? 'dup' : /triag/i.test(l) ? 'tri' : /verif/i.test(l) ? 'ver' : '';
const shortDate = s => s ? s.slice(0, 10) : '';
function refresh() {
  if (!state.loaded) return;
  const r = query();
  window._filtered = r.filtered;
  $('rows').innerHTML = r.rows.map(x => `<tr>
    <td class="num"><a href="${x.u}" target="_blank">#${x.n}</a></td>
    <td><a href="${x.u}" target="_blank">${esc(x.t)}</a>
        <span class="st ${x.st}">${x.st}</span>
        ${x.r ? `<span class="reason">· ${x.r.replace('_',' ')}</span>` : ''}</td>
    <td>${x.l.map(l => `<span class="lbl ${lblClass(l)}" data-lbl="${esc(l)}">${esc(l)}</span>`).join('')}</td>
    <td class="cmt">${x.c || ''}</td>
    <td class="date">${shortDate(x.ca)}</td>
    <td class="date">${shortDate(x.ua)}</td>
    <td class="date">${esc(x.cb)}</td></tr>`).join('') ||
    '<tr><td colspan="7" class="err">no matches</td></tr>';
  const f = r.facets;
  $('stats').innerHTML = `<b>${r.filtered}</b> of <b>${r.total}</b> issues · open <b>${f.open}</b> · closed <b>${f.closed}</b>` +
    ` · completed <b>${f.reasons.completed || 0}</b> · dup/not-planned <b>${f.reasons.not_planned || 0}</b> · untriaged <b>${f.reasons[''] || 0}</b>`;
  $('facets').innerHTML = f.labels.map(([name, ct]) =>
    `<span class="chip ${state.labels.has(name) ? 'on' : ''}" data-lbl="${esc(name)}">${esc(name)}<span class="ct">${ct}</span></span>`).join('');
  const pages = Math.ceil(r.filtered / state.limit);
  $('pageinfo').textContent = `page ${Math.floor(state.offset / state.limit) + 1} / ${Math.max(pages, 1)}`;
}

// ---------- events ----------
$('load').onclick = loadIssues;
let deb; $('q').oninput = () => { clearTimeout(deb); state.offset = 0; deb = setTimeout(refresh, 200); };
for (const id of ['state', 'reason', 'sort']) $(id).onchange = () => { state.offset = 0; refresh(); };
document.querySelectorAll('th[data-sort]').forEach(th => th.onclick = () => { $('sort').value = th.dataset.sort; refresh(); });
document.addEventListener('click', e => {
  const chip = e.target.closest('[data-lbl]');
  if (!chip) return;
  const l = chip.dataset.lbl;
  state.labels.has(l) ? state.labels.delete(l) : state.labels.add(l);
  state.offset = 0; refresh();
});
$('prev').onclick = () => { state.offset = Math.max(0, state.offset - state.limit); refresh(); };
$('next').onclick = () => { if (state.offset + state.limit < (window._filtered || 0)) state.offset += state.limit; refresh(); };
$('token').value = localStorage.getItem('sct-token') || '';

if (location.hash.startsWith('#/')) { $('repo').value = location.hash.slice(2); }
initWasm().then(loadIssues).catch(e => { $('status').textContent = 'wasm load failed: ' + e.message; });
