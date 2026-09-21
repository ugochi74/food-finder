const $ = s => document.querySelector(s);
const E = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const focusBy = (sel, key, val) => [...document.querySelectorAll(sel)].find(x => x.dataset[key] === val)?.focus();

let me = null;
try { me = JSON.parse(localStorage.getItem('me')); } catch (e) {}
let q = '', c = 'All', s = 'az', o = null, D = [], C = ['All'], mode = 'login', timer;

async function api(path, opt = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (me) h.Authorization = 'Bearer ' + me.token;
  const r = await fetch('/api' + path, { ...opt, headers: h });
  const j = await r.json().catch(() => null);
  if (r.status === 401 && me) setMe(null); // token expired or invalid
  if (!r.ok) {
    const d = j && j.detail;
    throw new Error(Array.isArray(d) ? d.map(x => x.msg).join('. ') : d || 'Something went wrong.');
  }
  return j;
}

function setMe(u) {
  me = u;
  u ? localStorage.setItem('me', JSON.stringify(u)) : localStorage.removeItem('me');
  drawAuth();
  view();
}

function drawAuth() {
  $('#auth').innerHTML = me
    ? `<span>Signed in as <b>${E(me.username)}</b></span><button class="btn" data-a="add">Add a dish</button><button class="btn ghost" data-a="out">Log out</button>`
    : `<button class="btn" data-a="in">Log in or sign up</button>`;
}

async function refresh() {
  C = ['All', ...(await api('/countries'))];
  if (!C.includes(c)) c = 'All';
  await load();
}

async function load() {
  const p = new URLSearchParams({ q, country: c === 'All' ? '' : c, sort: s });
  try { D = await api('/dishes?' + p); }
  catch (e) { $('#list').innerHTML = '<p class="empty">Could not load dishes. Check that the server is running.</p>'; return; }
  view();
}

function more(x) {
  const u = x.nutrition;
  return `<div class="more"><h3>About</h3><p>${E(x.description)}</p>` +
    (x.how_eaten ? `<h3>How it's eaten</h3><p>${E(x.how_eaten)}</p>` : '') +
    `<h3>Ingredients</h3><ul class="ing">${x.ingredients.map(i => `<li><span>${E(i.name)}</span><span>${E(i.quantity)}</span></li>`).join('')}</ul>` +
    `<h3>Nutrition per serving</h3><dl class="nut"><div><dt>Calories</dt><dd>${u.calories}</dd></div><div><dt>Protein</dt><dd>${u.protein} g</dd></div><div><dt>Carbs</dt><dd>${u.carbs} g</dd></div><div><dt>Fat</dt><dd>${u.fat} g</dd></div></dl>` +
    `<p class="tags">${x.tags.map(g => `<span>${E(g)}</span>`).join('')}</p>` +
    (me && x.owner_id === me.id ? `<p class="mine"><button class="btn pri" data-del="${x.id}">Delete this dish</button></p>` : '') + `</div>`;
}

function view() {
  const t = q.trim().toLowerCase();
  $('#chips').innerHTML = C.map(k => `<button class="chip" aria-pressed="${k === c}" data-c="${E(k)}">${E(k)}</button>`).join('');
  $('#count').textContent = D.length + (D.length === 1 ? ' dish' : ' dishes');
  $('#list').innerHTML = D.length ? D.map(x => {
    const on = o === x.id;
    const byIng = t && !x.name.toLowerCase().includes(t) && x.ingredients.some(i => i.name.toLowerCase().includes(t));
    return `<article class="dish${x.country === 'Nigeria' ? ' ng' : ''}"><button class="row" aria-expanded="${on}" data-id="${x.id}"><span><span class="name">${E(x.name)}</span><small><em>${E(x.country)}</em>${E(x.type)}${byIng ? `<span class="has">contains ${E(t)}</span>` : ''}</small></span><span class="kc">${x.nutrition.calories}<small> kcal</small></span></button>${on ? more(x) : ''}</article>`;
  }).join('') : '<p class="empty">No dishes match. Try an ingredient like "onion" or "beans", or choose All countries.</p>';
}

function openAuth(m) {
  mode = m;
  $('#atitle').textContent = m === 'login' ? 'Log in' : 'Create an account';
  $('#asubmit').textContent = m === 'login' ? 'Log in' : 'Sign up';
  $('#aswitch').textContent = m === 'login' ? 'New here? Create an account' : 'Have an account? Log in';
  $('#f-auth').elements.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('#aerr').textContent = '';
  if (!$('#dlg-auth').open) $('#dlg-auth').showModal();
}

// ----- events -----
$('#q').addEventListener('input', e => { q = e.target.value; clearTimeout(timer); timer = setTimeout(load, 200); });
$('#sort').addEventListener('change', e => { s = e.target.value; load(); });
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('[data-c]'); if (!b) return;
  c = b.dataset.c; load().then(() => focusBy('.chip', 'c', c));
});
$('#list').addEventListener('click', async e => {
  const d = e.target.closest('[data-del]');
  if (d) {
    if (!confirm('Delete this dish?')) return;
    try { await api('/dishes/' + d.dataset.del, { method: 'DELETE' }); o = null; await refresh(); }
    catch (x) { alert(x.message); }
    return;
  }
  const b = e.target.closest('[data-id]'); if (!b) return;
  const id = +b.dataset.id; o = o === id ? null : id; view(); focusBy('.row', 'id', String(id));
});
$('#auth').addEventListener('click', e => {
  const a = e.target.dataset.a;
  if (a === 'in') openAuth('login');
  if (a === 'out') setMe(null);
  if (a === 'add') { $('#f-add').reset(); $('#eadd').textContent = ''; $('#dlg-add').showModal(); }
});
$('#aswitch').addEventListener('click', () => openAuth(mode === 'login' ? 'register' : 'login'));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

$('#f-auth').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/' + mode, { method: 'POST', body: JSON.stringify({ username: f.get('username'), password: f.get('password') }) });
    $('#dlg-auth').close(); e.target.reset(); setMe(r);
  } catch (x) { $('#aerr').textContent = x.message; }
});

$('#f-add').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target), n = k => +f.get(k) || 0;
  const body = {
    name: f.get('name'), country: f.get('country'), type: f.get('type'),
    description: f.get('description'), how_eaten: f.get('how_eaten'),
    tags: f.get('tags').split(','),
    ingredients: f.get('ingredients').split('\n').map(l => { const p = l.split(','); return { name: p[0].trim(), quantity: p.slice(1).join(',').trim() }; }).filter(i => i.name),
    nutrition: { calories: n('calories'), protein: n('protein'), carbs: n('carbs'), fat: n('fat') }
  };
  try { await api('/dishes', { method: 'POST', body: JSON.stringify(body) }); $('#dlg-add').close(); await refresh(); }
  catch (x) { $('#eadd').textContent = x.message; }
});

drawAuth();
refresh();
