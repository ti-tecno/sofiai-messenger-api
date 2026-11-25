// Backoffice de SofIA Messenger: resumen, actividad por evento (ref), mensajes, conversaciones y
// envío de plantillas en nombre de cada app. Habla con /v1/admin/console/* usando la llave de
// administración, que se guarda solo en esta pestaña (sessionStorage).
// Todo el contenido se arma con textContent: los mensajes de terceros nunca se interpretan como HTML.

const KEY_STORAGE = 'sofiai-messenger-admin-key';
const TZ = 'America/Mexico_City';
const API = '/v1/admin/console';
const PRICE = { UTILITY: 0.0085, AUTHENTICATION: 0.0085, MARKETING: 0.0436 }; // USD aprox. por mensaje en México

const $ = (sel) => document.querySelector(sel);
// replaceChildren ignora los null/false de las secciones opcionales (si no, se pintaría "null")
const main = () => {
  const el = $('#main');
  return { el, replaceChildren: (...nodes) => el.replaceChildren(...nodes.filter((x) => x != null && x !== false)) };
};

// ── utilidades ───────────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmtDate = (iso, withYear = false) => (iso
  ? new Intl.DateTimeFormat('es-MX', { timeZone: TZ, day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
  : '—');
const fmtPhone = (p) => (p && p.startsWith('52') && p.length === 12 ? `${p.slice(2, 5)} ${p.slice(5, 8)} ${p.slice(8)}` : p ? `+${p}` : '—');
const n = (v) => Number(v ?? 0).toLocaleString('es-MX');
const usd = (v) => `US$${v.toFixed(2)}`;
// Costo estimado (lo calcula el servidor: plantillas no fallidas × tarifa de México por categoría)
const COST_NOTE = 'Costo estimado: plantillas enviadas que no fallaron × tarifa de Meta para México (utilidad US$0.0085, marketing US$0.0436). Las respuestas de texto libre no se cobran. Es una referencia: la factura de Meta puede ser menor (no cobra plantillas de utilidad dentro de una conversación abierta) y se cobra en tu moneda.';
const costCell = (c) => (c && c.billable ? h('span', { title: `${n(c.billable)} plantilla(s) cobrable(s)` }, usd(c.costUsd)) : '—');

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

const STATUS = {
  sending: ['Enviando', 'blue'], sent: ['Enviado', 'blue'], delivered: ['Entregado', 'good'], read: ['Leído', 'good'],
  failed: ['Falló', 'bad'], received: ['Recibido', ''],
};
const statusBadge = (s) => { const [label, cls] = STATUS[s] ?? [s, '']; return h('span', { class: `badge ${cls}` }, label); };

// ── API ──────────────────────────────────────────────────────────────────────
const getKey = () => { try { return sessionStorage.getItem(KEY_STORAGE); } catch { return null; } };

async function api(path, { method = 'GET', body, key = getKey() } = {}) {
  const res = await fetch(path.startsWith('/') ? path : `${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${key ?? ''}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) { const msg = 'La llave de administración no es válida'; logout(msg); throw new Error(msg); }
  if (!res.ok && !(json.results || json.message)) throw new Error(json.error?.message ?? `Error ${res.status}`);
  return { status: res.status, ...json };
}

// Resultados de un lote, en español
const RESULT_LABEL = { skipped: 'Omitido', failed: 'Falló', not_attempted: 'Sin intentar' };
const REASON_LABEL = {
  invalid_phone: 'Teléfono inválido',
  not_allowed: 'No está en SEND_ALLOWLIST (modo sandbox)',
  daily_limit: 'Se alcanzó el límite diario de la app',
};

// Apps y canales: se cargan una vez por sesión (se recargan al entrar al resumen)
let clientsCache = null;
async function clients(force = false) {
  if (!clientsCache || force) clientsCache = (await api('clients')).data;
  return clientsCache;
}
const clientName = (id) => clientsCache?.find((c) => c.id === Number(id))?.name ?? `App ${id}`;

// ── sesión ───────────────────────────────────────────────────────────────────
function logout(message) {
  try { sessionStorage.removeItem(KEY_STORAGE); } catch { /* sin almacenamiento */ }
  clientsCache = null;
  renderLogin(typeof message === 'string' ? message : undefined);
}

function renderLogin(error) {
  $('#nav').hidden = true; $('#logout').hidden = true; $('#sandbox').hidden = true;
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'ADMIN_API_KEY', 'aria-label': 'Llave de administración' });
  const msg = h('div', { class: 'err' }, error ?? '');
  const form = h('form', {
    class: 'card',
    onsubmit: async (e) => {
      e.preventDefault();
      const key = input.value.trim();
      if (!key) return;
      try {
        await api('clients', { key });
        try { sessionStorage.setItem(KEY_STORAGE, key); } catch { /* sin almacenamiento: no se recordará */ }
        route();
      } catch (err) { if (msg.isConnected) msg.textContent = err.message; }
    },
  },
  h('h1', {}, 'Entrar al backoffice'),
  h('p', { class: 'sub' }, 'Usa la llave de administración del mensajero (ADMIN_API_KEY). Se guarda solo en esta pestaña.'),
  input, msg,
  h('button', { class: 'btn primary', type: 'submit' }, 'Entrar'));
  main().replaceChildren(h('div', { class: 'login' }, form));
  input.focus();
}

// ── vistas ───────────────────────────────────────────────────────────────────
const VIEWS = { resumen: viewSummary, eventos: viewRefs, mensajes: viewMessages, conversaciones: viewConversations, enviar: viewSend };

function params() {
  const [, query = ''] = location.hash.split('?');
  return Object.fromEntries(new URLSearchParams(query));
}
function go(view, p = {}) {
  const q = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  location.hash = `${view}${q ? `?${q}` : ''}`;
}

async function route() {
  if (!getKey()) return renderLogin();
  $('#nav').hidden = false; $('#logout').hidden = false;
  const view = (location.hash.slice(1).split('?')[0] || 'resumen');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${view}`));
  main().replaceChildren(h('p', { class: 'muted' }, 'Cargando…'));
  try {
    await clients();
    await (VIEWS[view] ?? viewSummary)(params());
  } catch (err) {
    main().replaceChildren(h('div', { class: 'notice bad' }, err.message));
  }
}

function rangeSelect(value, onchange) {
  return h('label', {}, 'Periodo',
    h('select', { onchange: (e) => onchange(e.target.value) },
      [['7', 'Últimos 7 días'], ['30', 'Últimos 30 días'], ['90', 'Últimos 90 días'], ['365', 'Último año'], ['3650', 'Todo']]
        .map(([v, l]) => h('option', { value: v, selected: v === value }, l))));
}
const sinceFor = (days) => new Date(Date.now() - Number(days || 30) * 86400000).toISOString();

function table(headers, rowsData, { empty = 'Sin datos.', onRow } = {}) {
  if (!rowsData.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, empty));
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, headers.map(([label, cls]) => h('th', { class: cls }, label)))),
    h('tbody', {}, rowsData.map((r) => h('tr', { class: onRow ? 'click' : '', onclick: onRow ? () => onRow(r) : null },
      r.cells.map((c, i) => h('td', { class: headers[i][1] }, c)))))));
}

// Interruptor por app: apagada, su llave recibe 403 CLIENT_DISABLED en toda la API (no envía ni consulta).
// Lo que le contesten se sigue guardando; solo no se le avisa por webhook mientras esté apagada.
async function toggleClient(c, p) {
  const turnOn = !c.active;
  const question = turnOn
    ? `¿Encender "${c.name}"? Podrá enviar mensajes de inmediato (cada plantilla entregada se cobra).`
    : `¿Apagar "${c.name}"? Dejará de enviar y de consultar hasta que la vuelvas a encender.`;
  if (!window.confirm(question)) return;
  try {
    await api(`/v1/admin/clients/${c.id}`, { method: 'PATCH', body: { active: turnOn } });
    toast(`${c.name}: ${turnOn ? 'encendida' : 'apagada'}`);
    await viewSummary(p);
  } catch (e) { toast(e.message); }
}

// Resumen
async function viewSummary(p) {
  const days = p.dias || '30';
  const s = await api(`summary?since=${encodeURIComponent(sinceFor(days))}`);
  await clients(true);
  const sb = $('#sandbox');
  sb.hidden = !s.sandbox; sb.textContent = s.sandbox ? `Sandbox: solo ${s.sandbox.recipients} teléfono(s)` : '';
  const ok = (c) => c.out.delivered + c.out.read;
  main().replaceChildren(
    h('h1', {}, 'Resumen'),
    h('p', { class: 'sub' }, 'Mensajes de todas las apps conectadas al mensajero.'),
    h('div', { class: 'filters' }, rangeSelect(days, (v) => go('resumen', { dias: v }))),
    s.sandbox ? h('div', { class: 'notice warn' }, `Modo sandbox: el mensajero solo envía a ${s.sandbox.recipients} teléfono(s) de SEND_ALLOWLIST; el resto se rechaza sin llamar a Meta.`) : null,
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('b', {}, n(s.totals.outTotal)), h('span', {}, 'enviados')),
      h('div', { class: 'tile good' }, h('b', {}, n(ok(s.totals))), h('span', {}, 'entregados o leídos')),
      h('div', { class: 'tile' }, h('b', {}, n(s.totals.out.read)), h('span', {}, 'leídos')),
      h('div', { class: `tile ${s.totals.out.failed ? 'bad' : ''}` }, h('b', {}, n(s.totals.out.failed)), h('span', {}, 'fallidos')),
      h('div', { class: 'tile' }, h('b', {}, n(s.totals.in)), h('span', {}, 'recibidos')),
      h('div', { class: `tile ${s.totals.unread ? 'bad' : ''}` }, h('b', {}, n(s.totals.unread)), h('span', {}, 'sin leer')),
      h('div', { class: 'tile', title: COST_NOTE }, h('b', {}, usd(s.totals.cost.costUsd)), h('span', {}, `costo estimado (${n(s.totals.cost.billable)} plantillas)`))),
    h('p', { class: 'muted' }, COST_NOTE),
    h('h2', {}, 'Por app'),
    table(
      [['App'], ['Estado'], ['Servicio'], ['Enviados', 'num'], ['Entregados/leídos', 'num'], ['Fallidos', 'num'], ['Recibidos', 'num'], ['Sin leer', 'num'], ['Costo est.', 'num'], ['Últimas 24 h / límite', 'num'], ['Última actividad']],
      s.clients.map((c) => ({
        c,
        cells: [
          c.name,
          c.active ? h('span', { class: 'badge good' }, 'Activa') : h('span', { class: 'badge' }, 'Desactivada'),
          h('button', { type: 'button', class: 'btn', title: c.active ? 'Apagar: la app deja de enviar y de consultar (403 CLIENT_DISABLED)' : 'Encender cuando la app tenga su servicio pagado', onclick: (e) => { e.stopPropagation(); toggleClient(c, p); } }, c.active ? 'Apagar' : 'Encender'),
          n(c.outTotal), n(ok(c)), n(c.out.failed), n(c.in), n(c.unread), costCell(c.cost),
          c.dailyLimit ? h('span', { class: c.usage24h >= c.dailyLimit ? 'err' : '' }, `${n(c.usage24h)} / ${n(c.dailyLimit)}`) : `${n(c.usage24h)} / sin límite`,
          fmtDate(c.lastAt),
        ],
      })),
      { empty: 'No hay apps registradas.', onRow: (r) => go('eventos', { app: r.c.id, dias: days }) },
    ),
    h('h2', {}, 'Por número (canal)'),
    table(
      [['Canal'], ['Número'], ['Configurado'], ['Enviados', 'num'], ['Fallidos', 'num'], ['Recibidos', 'num'], ['Sin leer', 'num'], ['Costo est.', 'num']],
      s.channels.map((c) => ({ cells: [`${c.name} (${c.slug})`, c.displayPhone ?? '—', c.configured ? h('span', { class: 'badge good' }, 'Sí') : h('span', { class: 'badge bad' }, 'No'), n(c.outTotal), n(c.out.failed), n(c.in), n(c.unread), costCell(c.cost)] })),
      { empty: 'No hay canales.' },
    ),
    s.unassigned.in ? h('p', { class: 'muted' }, `${n(s.unassigned.in)} mensaje(s) recibido(s) no se pudieron asignar a ninguna app (el canal no tiene app por defecto).`) : null,
  );
}

// Por evento (ref)
async function viewRefs(p) {
  const days = p.dias || '30';
  const q = new URLSearchParams({ since: sinceFor(days) });
  if (p.app) q.set('client', p.app);
  const r = await api(`refs?${q}`);
  const list = await clients();
  const filterText = (p.buscar || '').toLowerCase();
  const data = r.data.filter((x) => !filterText || `${x.label ?? ''} ${x.ref}`.toLowerCase().includes(filterText));
  main().replaceChildren(
    h('h1', {}, 'Por evento'),
    h('p', { class: 'sub' }, 'Actividad agrupada por la referencia que manda cada app (en Eventopolis, un evento). Clic en una fila para ver sus mensajes.'),
    h('div', { class: 'filters' },
      h('label', {}, 'App', h('select', { onchange: (e) => go('eventos', { ...p, app: e.target.value }) },
        h('option', { value: '' }, 'Todas'), list.map((c) => h('option', { value: c.id, selected: String(c.id) === p.app }, c.name)))),
      rangeSelect(days, (v) => go('eventos', { ...p, dias: v })),
      h('label', {}, 'Buscar', h('input', { value: p.buscar ?? '', placeholder: 'Nombre o ref', onchange: (e) => go('eventos', { ...p, buscar: e.target.value }) }))),
    table(
      [['Evento / ref'], ['App'], ['Personas', 'num'], ['Enviados', 'num'], ['Entregados', 'num'], ['Leídos', 'num'], ['Fallidos', 'num'], ['Recibidos', 'num'], ['Sin leer', 'num'], ['Costo est.', 'num'], ['Última actividad']],
      data.map((x) => ({
        x,
        cells: [
          h('div', {}, x.label ?? x.ref, x.label ? h('div', { class: 'muted' }, x.ref) : null),
          x.clientName ?? '—', n(x.phones), n(x.outTotal), n(x.delivered), n(x.read),
          x.failed ? h('span', { class: 'err' }, n(x.failed)) : '0', n(x.inbound),
          x.unread ? h('span', { class: 'badge bad' }, n(x.unread)) : '0', costCell(x.cost), fmtDate(x.lastAt),
        ],
      })),
      { empty: 'Sin actividad con referencia en este periodo.', onRow: (row) => go('mensajes', { app: row.x.clientId, ref: row.x.ref, etiqueta: row.x.label ?? '' }) },
    ),
    data.length ? h('p', { class: 'muted' }, `Costo estimado de lo mostrado: ${usd(data.reduce((t, x) => t + (x.cost?.costUsd ?? 0), 0))}. ${COST_NOTE}`) : null,
  );
}

// Mensajes
async function viewMessages(p) {
  const limit = 50;
  const offset = Number(p.desde || 0);
  const q = new URLSearchParams({ limit, offset });
  for (const [k, qk] of [['app', 'client'], ['ref', 'ref'], ['direccion', 'direction'], ['estado', 'status'], ['tel', 'phone']]) if (p[k]) q.set(qk, p[k]);
  if (p.dias) q.set('since', sinceFor(p.dias));
  const r = await api(`messages?${q}`);
  const list = await clients();
  const set = (k) => (e) => go('mensajes', { ...p, [k]: e.target.value, desde: 0 });
  main().replaceChildren(
    h('h1', {}, p.etiqueta ? `Mensajes · ${p.etiqueta}` : 'Mensajes'),
    h('p', { class: 'sub' }, `${n(r.total)} mensaje(s).`, p.app && p.ref ? h('span', {}, ' ', h('a', { href: `#conversaciones?app=${encodeURIComponent(p.app)}&ref=${encodeURIComponent(p.ref)}` }, 'Ver conversaciones de este evento')) : null),
    h('div', { class: 'filters' },
      h('label', {}, 'App', h('select', { onchange: set('app') },
        h('option', { value: '' }, 'Todas'), list.map((c) => h('option', { value: c.id, selected: String(c.id) === p.app }, c.name)),
        h('option', { value: 'none', selected: p.app === 'none' }, 'Sin app (no asignados)'))),
      h('label', {}, 'Ref', h('input', { value: p.ref ?? '', placeholder: 'event:14', onchange: set('ref') })),
      h('label', {}, 'Dirección', h('select', { onchange: set('direccion') },
        [['', 'Ambas'], ['out', 'Enviados'], ['in', 'Recibidos']].map(([v, l]) => h('option', { value: v, selected: v === (p.direccion ?? '') }, l)))),
      h('label', {}, 'Estado', h('select', { onchange: set('estado') },
        [['', 'Todos'], ['failed', 'Fallidos'], ['sent', 'Enviados'], ['delivered', 'Entregados'], ['read', 'Leídos'], ['received', 'Recibidos']].map(([v, l]) => h('option', { value: v, selected: v === (p.estado ?? '') }, l)))),
      h('label', {}, 'Teléfono', h('input', { value: p.tel ?? '', placeholder: '55 1234 5678', onchange: set('tel') })),
      h('label', {}, 'Periodo', h('select', { onchange: set('dias') },
        [['', 'Todo'], ['1', 'Hoy y ayer'], ['7', '7 días'], ['30', '30 días']].map(([v, l]) => h('option', { value: v, selected: v === (p.dias ?? '') }, l))))),
    table(
      [['Fecha'], ['App'], ['Ref'], [''], ['Teléfono'], ['Contenido'], ['Estado']],
      r.data.map((m) => ({
        cells: [
          fmtDate(m.createdAt),
          m.clientName ?? h('span', { class: 'muted' }, 'sin app'),
          h('div', {}, m.metadata?.refLabel ?? m.ref ?? '—', m.metadata?.refLabel ? h('div', { class: 'muted' }, m.ref) : null),
          m.direction === 'out' ? 'Enviado' : 'Recibido',
          h('div', {}, fmtPhone(m.phone), m.profileName ? h('div', { class: 'muted' }, m.profileName) : null),
          h('div', {}, m.kind === 'template' ? h('span', { class: 'badge blue' }, `Plantilla: ${m.template}`) : (m.text ?? '—'),
            m.metadata?.origin === 'backoffice' ? h('div', {}, h('span', { class: 'badge warn' }, 'Desde el backoffice')) : null),
          h('div', {}, statusBadge(m.status), m.error ? h('div', { class: 'err' }, `${m.error.reason}. ${m.error.hint ?? ''}`) : null),
        ],
      })),
      { empty: 'No hay mensajes con estos filtros.' },
    ),
    h('div', { class: 'pager' },
      h('button', { class: 'btn', disabled: offset === 0, onclick: () => go('mensajes', { ...p, desde: Math.max(0, offset - limit) }) }, 'Anteriores'),
      h('span', { class: 'muted' }, `${n(Math.min(offset + 1, r.total))}–${n(Math.min(offset + limit, r.total))} de ${n(r.total)}`),
      h('button', { class: 'btn', disabled: offset + limit >= r.total, onclick: () => go('mensajes', { ...p, desde: offset + limit }) }, 'Siguientes')),
  );
}

// Conversaciones de una app
async function viewConversations(p) {
  const list = await clients();
  const appId = p.app || list[0]?.id;
  const picker = h('div', { class: 'filters' },
    h('label', {}, 'App', h('select', { onchange: (e) => go('conversaciones', { app: e.target.value }) },
      list.map((c) => h('option', { value: c.id, selected: String(c.id) === String(appId) }, c.name)))),
    h('label', {}, 'Ref (opcional)', h('input', { value: p.ref ?? '', placeholder: 'event:14', onchange: (e) => go('conversaciones', { ...p, app: appId, ref: e.target.value, tel: '' }) })));
  if (!appId) { main().replaceChildren(h('h1', {}, 'Conversaciones'), h('p', { class: 'sub' }, 'No hay apps registradas.')); return; }

  const refQ = p.ref ? `?ref=${encodeURIComponent(p.ref)}` : '';
  const convs = (await api(`clients/${appId}/conversations${refQ}`)).data;
  const listPane = h('div', { class: 'list' }, convs.length ? convs.map((c) => h('button', {
    class: c.phone === p.tel ? 'on' : '',
    onclick: () => go('conversaciones', { ...p, app: appId, tel: c.phone }),
  },
  h('div', {}, h('b', {}, c.profileName ?? fmtPhone(c.phone)), ' ', c.unread ? h('span', { class: 'badge bad' }, String(c.unread)) : null),
  h('div', { class: 'muted' }, `${c.last.direction === 'out' ? 'Enviado: ' : ''}${c.last.text ?? '—'}`),
  h('div', { class: 'muted' }, `${fmtPhone(c.phone)} · ${c.ref ?? 'sin ref'} · ${fmtDate(c.last.at)}`))) : h('div', { class: 'empty' }, 'Nadie ha escrito todavía.'));

  let threadPane = h('div', { class: 'thread' }, h('div', { class: 'empty' }, 'Elige una conversación.'));
  if (p.tel) {
    const t = await api(`clients/${appId}/conversations/${encodeURIComponent(p.tel)}${refQ}`);
    if (t.messages.some((m) => m.direction === 'in' && !m.readAt)) await api(`clients/${appId}/conversations/${encodeURIComponent(p.tel)}/read`, { method: 'POST', body: p.ref ? { ref: p.ref } : {} });
    const open = t.windowUntil && new Date(t.windowUntil) > new Date();
    const text = h('textarea', { rows: 2, maxlength: 4096, placeholder: 'Escribe la respuesta…', 'aria-label': 'Respuesta' });
    const send = h('button', { class: 'btn primary' }, 'Enviar');
    send.addEventListener('click', async () => {
      if (!text.value.trim()) return;
      if (!confirm(`¿Enviar esta respuesta a ${fmtPhone(p.tel)} a nombre de "${clientName(appId)}"?`)) return;
      send.disabled = true;
      try {
        const last = [...t.messages].reverse().find((m) => m.ref);
        const r = await api(`clients/${appId}/messages/text`, { method: 'POST', body: { to: p.tel, text: text.value.trim(), ...(last?.ref ? { ref: last.ref } : {}), idempotencyKey: `bo:${Date.now()}:${p.tel}` } });
        if (r.error) throw new Error(`${r.error.reason ?? r.error.message}`);
        toast('Respuesta enviada'); route();
      } catch (err) { toast(err.message); send.disabled = false; }
    });
    threadPane = h('div', { class: 'thread' },
      h('div', { class: 'head' }, h('b', {}, t.profileName ?? fmtPhone(t.phone)), h('div', { class: 'muted' }, `${fmtPhone(t.phone)} · ${clientName(appId)}`)),
      h('div', { class: 'msgs' }, t.messages.map((m) => h('div', { class: `bubble ${m.direction === 'out' ? 'out' : ''} ${m.kind === 'template' ? 'tpl' : ''}` },
        m.kind === 'template' ? h('div', { class: 'tag' }, `Plantilla ${m.template}`) : null,
        m.metadata?.origin === 'backoffice' ? h('div', { class: 'tag' }, 'Desde el backoffice') : null,
        m.kind === 'template' ? Object.entries(m.parameters?.body ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—' : (m.text ?? '—'),
        h('div', { class: 'meta' }, `${fmtDate(m.createdAt)}${m.direction === 'out' ? ` · ${STATUS[m.status]?.[0] ?? m.status}` : ''}`),
        m.error ? h('div', { class: 'err' }, m.error.reason) : null))),
      open
        ? h('div', { class: 'reply' }, text, send)
        : h('div', { class: 'reply' }, h('div', { class: 'notice warn small' }, 'Pasaron más de 24 h desde su último mensaje: WhatsApp solo permite enviarle plantillas (pestaña Enviar).')));
    requestAnimationFrame(() => { const box = threadPane.querySelector('.msgs'); if (box) box.scrollTop = box.scrollHeight; });
  }
  main().replaceChildren(
    h('h1', {}, 'Conversaciones'),
    h('p', { class: 'sub' }, 'Lo que contestan las personas a cada app. Las respuestas salen a nombre de esa app y solo dentro de las 24 h de su último mensaje.'),
    picker,
    h('div', { class: 'inbox' }, listPane, threadPane),
  );
}

// Enviar una plantilla en nombre de una app
async function viewSend(p) {
  const list = (await clients()).filter((c) => c.active);
  if (!list.length) { main().replaceChildren(h('h1', {}, 'Enviar'), h('p', { class: 'sub' }, 'No hay apps activas.')); return; }
  const app = list.find((c) => String(c.id) === p.app) ?? list[0];
  const channels = app.channels.filter((c) => c.configured);
  const channel = channels.find((c) => c.slug === p.canal) ?? channels.find((c) => c.isDefault) ?? channels[0];

  const head = [
    h('h1', {}, 'Enviar'),
    h('p', { class: 'sub' }, 'Envía una plantilla aprobada por Meta a nombre de una app. Se aplican sus reglas: su canal, su límite diario y el sandbox.'),
    h('div', { class: 'notice warn small' }, 'Lo que envíes desde aquí queda en el mensajero (y se ve en Mensajes), pero la app no lo tiene en su propio historial. Las respuestas sí le llegan a la app.'),
    h('div', { class: 'filters' },
      h('label', {}, 'App', h('select', { onchange: (e) => go('enviar', { app: e.target.value }) }, list.map((c) => h('option', { value: c.id, selected: c.id === app.id }, c.name)))),
      h('label', {}, 'Número (canal)', h('select', { onchange: (e) => go('enviar', { app: app.id, canal: e.target.value }) },
        channels.length ? channels.map((c) => h('option', { value: c.slug, selected: c.slug === channel?.slug }, `${c.name}${c.displayPhone ? ` (${c.displayPhone})` : ''}`)) : h('option', { value: '' }, 'Sin canales configurados')))),
  ];
  if (!channel) { main().replaceChildren(...head, h('div', { class: 'notice bad' }, 'Esta app no tiene un canal configurado (número y token).')); return; }

  main().replaceChildren(...head, h('p', { class: 'muted' }, 'Cargando plantillas…'));
  let templates;
  try { templates = (await api(`channels/${encodeURIComponent(channel.slug)}/templates`)).data; } catch (err) {
    main().replaceChildren(...head, h('div', { class: 'notice bad' }, err.message)); return;
  }
  const usable = templates.filter((t) => t.sendable);
  if (!usable.length) { main().replaceChildren(...head, h('div', { class: 'notice warn' }, 'Esta cuenta no tiene plantillas aprobadas que se puedan enviar desde aquí.')); return; }
  const tpl = usable.find((t) => t.name === p.plantilla) ?? usable[0];

  const values = {};
  const inputs = tpl.params.map((name) => {
    const el = h('input', { placeholder: name, oninput: () => { values[name] = el.value; refresh(); } });
    return h('label', { class: 'field' }, name, el);
  });
  const suffix = tpl.urlButton?.hasSuffix ? h('input', { placeholder: 'final de la URL', oninput: refresh }) : null;
  const image = tpl.needsHeaderImage ? h('input', { placeholder: 'https://…/imagen.jpg', oninput: refresh }) : null;
  const recipients = h('textarea', { rows: 5, class: 'wide', placeholder: 'Un teléfono por renglón (máx. 500)\n55 1234 5678', oninput: refresh });
  const ref = h('input', { value: p.ref ?? '', placeholder: 'event:14 (opcional, para agruparlo en "Por evento")' });
  const preview = h('div', { class: 'preview' });
  const info = h('div', { class: 'muted' });
  const sendBtn = h('button', { class: 'btn primary' }, 'Enviar');
  const result = h('div');

  function phones() {
    return [...new Set(recipients.value.split(/[\n,;]+/).map((x) => x.replace(/[^\d+]/g, '')).filter((x) => x.replace(/\D/g, '').length >= 10))];
  }
  function refresh() {
    const lines = [];
    if (tpl.headerText) lines.push(`*${tpl.headerText}*`);
    lines.push(tpl.bodyText.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, (_m, k) => values[k] || `{{${k}}}`));
    if (tpl.footerText) lines.push(tpl.footerText);
    if (tpl.urlButton) lines.push(`[${tpl.urlButton.text}] ${tpl.urlButton.url.replace(/\{\{\s*1\s*\}\}/, suffix?.value || '{{1}}')}`);
    preview.textContent = lines.join('\n\n');
    const count = phones().length;
    const price = PRICE[tpl.category] ?? PRICE.UTILITY;
    info.textContent = `${count} destinatario(s) · costo aproximado ${usd(count * price)} (${tpl.category?.toLowerCase() ?? 'utility'}, tarifa de México)`;
    sendBtn.textContent = count ? `Enviar a ${count}` : 'Enviar';
    sendBtn.disabled = !count || tpl.params.some((k) => !values[k]?.trim()) || (suffix && !suffix.value.trim()) || (image && !/^https:\/\//.test(image.value));
  }

  sendBtn.addEventListener('click', async () => {
    const list2 = phones();
    if (!list2.length) return;
    if (!confirm(`¿Enviar la plantilla "${tpl.name}" a ${list2.length} teléfono(s) a nombre de "${app.name}" desde ${channel.name}?`)) return;
    sendBtn.disabled = true;
    const stamp = Date.now();
    const parameters = {
      ...(tpl.params.length ? { body: Object.fromEntries(tpl.params.map((k) => [k, values[k].trim()])) } : {}),
      ...(suffix ? { buttonUrlSuffix: suffix.value.trim() } : {}),
      ...(image ? { headerImageUrl: image.value.trim() } : {}),
    };
    const messages = list2.map((to) => ({ to, channel: channel.slug, template: tpl.name, language: tpl.language, parameters, ...(ref.value.trim() ? { ref: ref.value.trim() } : {}), idempotencyKey: `bo:${stamp}:${to.replace(/\D/g, '')}` }));
    const totals = { sent: 0, duplicate: 0, skipped: 0, failed: 0, notAttempted: 0 };
    const problems = [];
    result.replaceChildren(h('p', { class: 'muted' }, 'Enviando…'));
    try {
      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100);
        const r = await api(`clients/${app.id}/messages/template/batch`, { method: 'POST', body: { messages: chunk } });
        for (const k of Object.keys(totals)) totals[k] += r.summary?.[k] ?? 0;
        (r.results ?? []).forEach((x) => {
          if (x.status !== 'sent' && x.status !== 'duplicate') problems.push([chunk[x.index].to, RESULT_LABEL[x.status] ?? x.status, REASON_LABEL[x.reason] ?? x.error?.reason ?? x.reason ?? '']);
        });
        result.replaceChildren(h('p', { class: 'muted' }, `Enviando… ${Math.min(i + 100, messages.length)} de ${messages.length}`));
        if (r.aborted) { problems.push(['—', 'detenido', r.abortReason ?? 'Error que afecta a todos los envíos']); break; }
      }
      result.replaceChildren(
        h('div', { class: `notice ${problems.length ? 'warn' : 'good'}` }, `Enviados: ${totals.sent}. Repetidos: ${totals.duplicate}. Omitidos: ${totals.skipped}. Fallidos: ${totals.failed}. Sin intentar: ${totals.notAttempted}.`),
        problems.length ? table([['Teléfono'], ['Resultado'], ['Motivo']], problems.map((x) => ({ cells: x }))) : null,
        h('p', {}, h('a', { href: `#mensajes?app=${app.id}${ref.value.trim() ? `&ref=${encodeURIComponent(ref.value.trim())}` : ''}&direccion=out` }, 'Ver los mensajes enviados')),
      );
    } catch (err) {
      result.replaceChildren(h('div', { class: 'notice bad' }, err.message));
    } finally { sendBtn.disabled = false; }
  });

  main().replaceChildren(...head,
    h('div', { class: 'grid2' },
      h('div', { class: 'card' },
        h('label', { class: 'field' }, 'Plantilla', h('select', { onchange: (e) => go('enviar', { app: app.id, canal: channel.slug, plantilla: e.target.value }) },
          usable.map((t) => h('option', { value: t.name, selected: t.name === tpl.name }, `${t.name} (${t.language}, ${String(t.category ?? '').toLowerCase()})`)))),
        templates.length > usable.length ? h('p', { class: 'muted' }, `${templates.length - usable.length} plantilla(s) aprobada(s) no se pueden llenar desde aquí (variables numeradas o encabezados especiales).`) : null,
        inputs.length ? h('div', {}, h('h2', {}, 'Variables'), inputs) : null,
        suffix ? h('label', { class: 'field' }, `Botón "${tpl.urlButton.text}": final de la URL`, suffix) : null,
        image ? h('label', { class: 'field' }, 'Imagen del encabezado (URL https)', image) : null,
        h('h2', {}, 'Destinatarios'), recipients,
        h('label', { class: 'field' }, 'Referencia', ref),
        h('p', {}, info), sendBtn, result),
      h('div', {}, h('h2', {}, 'Vista previa'), preview)));
  refresh();
}

// ── arranque ─────────────────────────────────────────────────────────────────
$('#logout').addEventListener('click', logout);
window.addEventListener('hashchange', route);
route();
