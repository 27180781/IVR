/**
 * The dashboard page.
 *
 * Deliberately one self-contained file with no external assets: it is served
 * by the same process that answers calls, so it must not depend on a CDN
 * being reachable, and a strict CSP keeps it that way.
 *
 * The client uses string concatenation rather than template literals so this
 * whole page can live inside one, with no escaping to get wrong.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>IVR — לוח בקרה</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --border: #e3e6ea; --text: #16191d;
    --muted: #6b727c; --accent: #2563eb; --ok: #157f4a; --warn: #b45309;
    --err: #c02626; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1116; --panel: #161a21; --border: #262c36; --text: #e6e9ee;
      --muted: #8b95a3; --accent: #5b8cff; --ok: #35c07a; --warn: #e0a33a;
      --err: #ef5f5f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 16px 22px; background: var(--panel); border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 10;
  }
  h1 { font-size: 17px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .spacer { flex: 1; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .dot.live { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
  .dot.down { background: var(--err); }
  .conn { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); }
  main { padding: 22px; max-width: 1400px; margin: 0 auto; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .tile { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .tile .label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .tile .value { font-size: 25px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 18px; overflow: hidden; }
  section > h2 {
    font-size: 13px; font-weight: 600; margin: 0; padding: 12px 16px; color: var(--muted);
    border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px;
  }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { padding: 9px 14px; text-align: right; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; position: sticky; top: 0; background: var(--panel); }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
  .mono { font-family: var(--mono); font-size: 12.5px; }
  .muted { color: var(--muted); }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
  .pill.ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .pill.warn { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
  .pill.err { background: color-mix(in srgb, var(--err) 16%, transparent); color: var(--err); }
  .path { font-family: var(--mono); font-size: 11.5px; color: var(--muted); white-space: normal; max-width: 480px; }
  .path b { color: var(--text); font-weight: 600; }
  /* Log lines are English and machine-generated; forcing them into the page's
     RTL flow puts the timestamp on the wrong side and reads badly. */
  #log {
    max-height: 380px; overflow-y: auto; font-family: var(--mono); font-size: 12px;
    padding: 10px 14px; direction: ltr; text-align: left;
  }
  #log div {
    padding: 3px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
    word-break: break-word; display: flex; gap: 10px; align-items: baseline;
  }
  #log .msg { flex: 1; }
  #log .lvl50, #log .lvl60 { color: var(--err); }
  #log .lvl40 { color: var(--warn); }
  #log time { color: var(--muted); flex: 0 0 auto; }
  #log .cid { color: var(--muted); flex: 0 0 auto; opacity: 0.75; }
  .empty { padding: 26px 16px; text-align: center; color: var(--muted); font-size: 13.5px; }
  button {
    font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 7px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>מערכת IVR</h1>
  <span class="conn"><span class="dot" id="dot"></span><span id="connText">מתחבר…</span></span>
  <span class="spacer"></span>
  <span class="muted mono" id="meta"></span>
</header>

<main>
  <div class="tiles">
    <div class="tile"><div class="label">שיחות פעילות</div><div class="value" id="tActive">—</div></div>
    <div class="tile"><div class="label">שיחות ב-24 שעות</div><div class="value" id="tDay">—</div></div>
    <div class="tile"><div class="label">הושלמו במלואן</div><div class="value" id="tDone">—</div></div>
    <div class="tile"><div class="label">משך ממוצע</div><div class="value" id="tAvg">—</div></div>
    <div class="tile"><div class="label">זמן פעילות</div><div class="value" id="tUp">—</div></div>
  </div>

  <section>
    <h2>שיחות פעילות כעת</h2>
    <div class="scroll"><table>
      <thead><tr><th>מאת</th><th>אל</th><th>שלב</th><th>משך</th></tr></thead>
      <tbody id="activeBody"></tbody>
    </table></div>
    <div class="empty" id="activeEmpty">אין שיחות פעילות</div>
  </section>

  <section>
    <h2>שיחות אחרונות <span class="spacer"></span> <button id="refresh">רענן</button></h2>
    <div class="scroll"><table>
      <thead><tr><th>מתי</th><th>מאת</th><th>משך</th><th>סיום</th><th>הזמנה</th><th>מסלול</th></tr></thead>
      <tbody id="callsBody"></tbody>
    </table></div>
    <div class="empty" id="callsEmpty">עדיין אין שיחות</div>
  </section>

  <section>
    <h2>יומן חי</h2>
    <div id="log"></div>
  </section>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function secs(ms) {
    if (ms == null) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' שנ\\'';
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function uptime(ms) {
    var m = Math.floor(ms / 60000);
    if (m < 60) return m + ' דק\\'';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' שע\\'';
    return Math.floor(h / 24) + ' ימים';
  }
  function clock(t) {
    var d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }

  var REASONS = {
    completed: ['ok', 'הושלמה'],
    'caller-hangup': ['warn', 'המתקשר ניתק'],
    error: ['err', 'תקלה'],
    'transition-limit': ['err', 'לולאה']
  };

  function renderActive(list) {
    // Kept so the one-second tick can refresh the live durations without
    // asking the server again.
    window.__active = list;
    var body = $('activeBody');
    $('activeEmpty').style.display = list.length ? 'none' : 'block';
    body.innerHTML = list.map(function (c) {
      return '<tr><td class="mono">' + esc(c.from) + '</td>' +
             '<td class="mono muted">' + esc(c.to) + '</td>' +
             '<td><span class="pill ok">' + esc(c.state) + '</span></td>' +
             '<td class="mono">' + secs(Date.now() - c.startedAt) + '</td></tr>';
    }).join('');
    $('tActive').textContent = list.length;
  }

  function renderCalls(rows) {
    var body = $('callsBody');
    $('callsEmpty').style.display = rows.length ? 'none' : 'block';
    body.innerHTML = rows.map(function (r) {
      var meta = REASONS[r.reason] || ['warn', r.reason];
      var ref = (r.vars && r.vars.reference) ? r.vars.reference : '';
      var status = (r.vars && r.vars.order) ? r.vars.order.status : '';
      var path = (r.path || []).map(function (p, i, a) {
        return i === a.length - 1 ? '<b>' + esc(p) + '</b>' : esc(p);
      }).join(' ← ');
      return '<tr>' +
        '<td class="mono muted">' + clock(r.startedAt) + '</td>' +
        '<td class="mono">' + esc(r.from) + '</td>' +
        '<td class="mono">' + secs(r.durationMs) + '</td>' +
        '<td><span class="pill ' + meta[0] + '">' + esc(meta[1]) + '</span></td>' +
        '<td class="mono">' + esc(ref) + (status ? ' <span class="muted">' + esc(status) + '</span>' : '') + '</td>' +
        '<td class="path">' + path + '</td></tr>';
    }).join('');

    var dayAgo = Date.now() - 86400000;
    var recent = rows.filter(function (r) { return new Date(r.startedAt).getTime() > dayAgo; });
    $('tDay').textContent = recent.length;
    var done = recent.filter(function (r) { return r.reason === 'completed'; }).length;
    $('tDone').textContent = recent.length ? Math.round((done / recent.length) * 100) + '%' : '—';
    var avg = recent.length
      ? recent.reduce(function (s, r) { return s + (r.durationMs || 0); }, 0) / recent.length
      : 0;
    $('tAvg').textContent = recent.length ? secs(avg) : '—';
  }

  function appendLog(line) {
    var box = $('log');
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    var el = document.createElement('div');
    el.className = 'lvl' + line.level;
    var extra = line.callId ? '<span class="cid">' + esc(line.callId) + '</span>' : '';
    el.innerHTML = '<time>' + clock(line.time) + '</time>' +
                   '<span class="msg">' + esc(line.msg) + '</span>' + extra;
    box.appendChild(el);
    while (box.childElementCount > 400) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function get(path) { return fetch(path).then(function (r) { return r.json(); }); }

  function refreshAll() {
    get('/api/calls?limit=200').then(renderCalls).catch(function () {});
    get('/api/active').then(renderActive).catch(function () {});
    get('/api/summary').then(function (s) {
      $('tUp').textContent = uptime(s.uptimeMs);
      $('meta').textContent = s.ariApp + ' · ' + s.dataSource + ' · ' + s.language;
    }).catch(function () {});
  }

  $('refresh').addEventListener('click', refreshAll);

  get('/api/logs').then(function (lines) { lines.forEach(appendLog); }).catch(function () {});
  refreshAll();
  setInterval(function () { renderActive(window.__active || []); }, 1000);
  setInterval(refreshAll, 30000);

  function connect() {
    var es = new EventSource('/api/stream');
    es.onopen = function () {
      $('dot').className = 'dot live';
      $('connText').textContent = 'מחובר';
    };
    es.onerror = function () {
      $('dot').className = 'dot down';
      $('connText').textContent = 'מנותק — מנסה שוב';
    };
    es.addEventListener('log', function (e) { appendLog(JSON.parse(e.data)); });
    es.addEventListener('call-started', function () { refreshAll(); });
    es.addEventListener('call-state', function () { get('/api/active').then(renderActive); });
    es.addEventListener('call-ended', function () { setTimeout(refreshAll, 400); });
  }
  connect();
})();
</script>
</body>
</html>`;
