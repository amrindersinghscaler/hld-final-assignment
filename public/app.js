const $ = sel => document.querySelector(sel);
const input = $('#q'), dd = $('#dropdown'), meta = $('#meta'), form = $('#form'), result = $('#result');

const DEBOUNCE_MS = 140;
let debounceTimer = null;
let lastReqId = 0;
let active = -1;
let current = [];

function escape(s) { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function highlight(q, prefix) {
  const lower = q.toLowerCase();
  if (!prefix || !lower.startsWith(prefix)) return escape(q);
  return `<b>${escape(q.slice(0, prefix.length))}</b>${escape(q.slice(prefix.length))}`;
}

function renderDropdown(suggestions, prefix) {
  current = suggestions;
  active = -1;
  if (!suggestions.length) {
    dd.innerHTML = `<div class="empty">no matches for “${escape(prefix)}”</div>`;
    dd.hidden = false;
    return;
  }
  dd.innerHTML = suggestions.map((q, i) =>
    `<div class="item" role="option" data-i="${i}">
       <span class="q">${highlight(q, prefix)}</span>
       <span class="badge">#${i + 1}</span>
     </div>`
  ).join('');
  dd.hidden = false;
}

function setActive(i) {
  const items = [...dd.querySelectorAll('.item')];
  items.forEach(el => el.classList.remove('active'));
  if (items.length === 0) return;
  active = (i + items.length) % items.length;
  items[active].classList.add('active');
  items[active].scrollIntoView({ block: 'nearest' });
}

async function fetchSuggest(prefix) {
  const reqId = ++lastReqId;
  if (!prefix) { dd.hidden = true; meta.innerHTML = ''; return; }
  try {
    const r = await fetch(`/suggest?q=${encodeURIComponent(prefix)}`);
    const data = await r.json();
    if (reqId !== lastReqId) return; // stale response
    renderDropdown(data.suggestions, prefix);
    const hitClass = data.hit ? 'hit' : 'miss';
    const hitText  = data.hit ? 'cache HIT' : 'cache MISS';
    meta.innerHTML = `<span class="pill ${hitClass}">${hitText}</span>
                      <span class="pill">node: ${data.nodeId ?? '—'}</span>
                      <span class="pill">latency: ${data.latencyMs} ms</span>
                      <span class="pill">results: ${data.suggestions.length}</span>`;
  } catch (e) {
    meta.innerHTML = `<span class="pill miss">error: ${escape(String(e.message || e))}</span>`;
  }
}

input.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = input.value.trim().toLowerCase();
  debounceTimer = setTimeout(() => fetchSuggest(q), DEBOUNCE_MS);
});

input.addEventListener('keydown', (e) => {
  if (dd.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
  else if (e.key === 'Escape') { dd.hidden = true; }
  else if (e.key === 'Enter' && active >= 0) {
    e.preventDefault();
    input.value = current[active];
    submit();
  }
});

dd.addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  input.value = current[Number(item.dataset.i)];
  submit();
});

async function submit() {
  const q = input.value.trim();
  if (!q) return;
  dd.hidden = true;
  try {
    const r = await fetch('/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q }),
    });
    const data = await r.json();
    result.hidden = false;
    result.innerHTML = `<div class="msg">${escape(data.message || 'ok')}</div>
                        <div class="q">submitted: <code>${escape(data.q || q)}</code></div>`;
    refreshTrending();
    refreshStats();
  } catch (e) {
    result.hidden = false;
    result.innerHTML = `<div class="msg" style="color:var(--danger)">error: ${escape(String(e.message || e))}</div>`;
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

async function refreshTrending() {
  const r = await fetch('/trending?limit=10');
  const { trending } = await r.json();
  const ol = $('#trending');
  if (!trending.length) { ol.innerHTML = '<li><span>nothing trending yet — submit a few searches</span><span class="num"></span></li>'; return; }
  ol.innerHTML = trending.map(t =>
    `<li><span>${escape(t.query)}</span><span class="num">recent=${t.recent} · total=${t.count}</span></li>`
  ).join('');
}

async function refreshStats() {
  const r = await fetch('/stats');
  const s = await r.json();
  $('#stats').textContent = JSON.stringify(s, null, 2);
}

$('#refreshTrending').addEventListener('click', refreshTrending);
document.addEventListener('click', (e) => {
  if (!dd.contains(e.target) && e.target !== input) dd.hidden = true;
});

refreshTrending();
refreshStats();
setInterval(refreshStats, 3000);
