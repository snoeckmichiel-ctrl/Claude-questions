// app.js - het scherm: kaart, knoppen, verbinding met het GPS-kastje en opslaan.
(function () {
  'use strict';
  const { nmea, geo, isoxml, zip, demo } = window.TG;
  const STORE_KEY = 'trekkergps.v1';
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- toestand
  const settings = { field: 'Perceel 1', customer: '', farm: '', workWidth: 12, host: '', connection: '' };

  function newField() {
    return { origin: null, boundary: [], runs: [], log: [], workedM2: 0 };
  }

  let field = newField();
  let frame = null;                       // omrekening GPS naar meters
  let cache = { boundary: [], runs: [] }; // dezelfde punten in meters
  let recordingBoundary = false;
  let working = false;
  let last = null;                        // laatste positie
  let heading = 0;
  let lastLogT = 0;
  let lastDataAt = 0;
  let dirty = false;
  const view = { scale: 3, cx: 0, cy: 0, follow: true };

  const parser = new nmea.NmeaParser(onPosition);

  // ---------------------------------------------------------------- opslaan
  function save() {
    if (!dirty) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ settings, field }));
      dirty = false;
    } catch (e) {
      toast('Opslaan in de tablet lukt niet. Exporteer het perceel.');
    }
  }

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (data && data.settings) Object.assign(settings, data.settings);
      if (data && data.field) field = Object.assign(newField(), data.field);
    } catch (e) { /* niets opgeslagen of geen toegang */ }
    if (field.origin) setFrame(field.origin.lat, field.origin.lon);
  }

  function setFrame(lat, lon) {
    frame = new geo.LocalFrame(lat, lon);
    field.origin = { lat, lon };
    cache.boundary = field.boundary.map(p => frame.toXY(p.lat, p.lon));
    cache.runs = field.runs.map(run => run.map(p => frame.toXY(p.lat, p.lon)));
  }

  // ---------------------------------------------------------------- GPS
  function onPosition(pos) {
    if (!frame) setFrame(pos.lat, pos.lon);
    const xy = frame.toXY(pos.lat, pos.lon);
    const ll = { lat: +pos.lat.toFixed(9), lon: +pos.lon.toFixed(9) };

    if (pos.speedKmh !== null && pos.speedKmh > 0.5 && pos.course !== null) heading = pos.course;
    else if (last && geo.distance(last.xy, xy) > 0.3) {
      heading = (Math.atan2(xy.x - last.xy.x, xy.y - last.xy.y) * 180 / Math.PI + 360) % 360;
    }

    if (recordingBoundary) {
      const lb = cache.boundary[cache.boundary.length - 1];
      if (!lb || geo.distance(lb, xy) >= 1) {
        field.boundary.push(ll);
        cache.boundary.push(xy);
        dirty = true;
      }
    }

    if (working) {
      const run = field.runs[field.runs.length - 1];
      const runXY = cache.runs[cache.runs.length - 1];
      const lp = runXY[runXY.length - 1];
      const d = lp ? geo.distance(lp, xy) : 0;
      if (!lp || d >= 0.5) {
        if (lp && d < 50) field.workedM2 += d * settings.workWidth;  // grote sprong = GPS-fout
        run.push(ll);
        runXY.push(xy);
        dirty = true;
      }
      const now = Date.now();
      if (now - lastLogT >= 900) {  // ongeveer 1 per seconde, met marge voor schommelingen
        field.log.push({ t: now, lat: ll.lat, lon: ll.lon, quality: pos.quality });
        lastLogT = now;
      }
    }

    last = Object.assign({}, pos, { xy });
    lastDataAt = Date.now();
    if (view.follow) { view.cx = xy.x; view.cy = xy.y; }
    updateStatus();
    updateInfo();
    requestDraw();
  }

  // ---------------------------------------------------------------- verbindingen
  let conn = null;

  function disconnect() {
    if (conn) { try { conn.close(); } catch (e) { /* al dicht */ } }
    conn = null;
  }

  function connectWifi() {
    disconnect();
    const host = settings.host || location.host || '192.168.4.1';
    let ws = null, closed = false, retry = null;
    const open = () => {
      setConn('Verbinden met ' + host + '…');
      try { ws = new WebSocket('ws://' + host + '/ws'); } catch (e) { ws = null; }
      if (!ws) { retry = setTimeout(open, 3000); return; }
      ws.onopen = () => setConn('Wifi', 'ok');
      ws.onmessage = ev => { if (typeof ev.data === 'string') parser.feed(ev.data); };
      ws.onclose = () => {
        if (closed) return;
        setConn('Wifi verbroken', 'bad');
        retry = setTimeout(open, 2000);
      };
    };
    conn = { type: 'wifi', close() { closed = true; clearTimeout(retry); if (ws) ws.close(); } };
    settings.connection = 'wifi';
    dirty = true;
    open();
  }

  async function connectUsb() {
    if (!('serial' in navigator)) {
      toast('USB werkt alleen in Chrome of Edge op een computer of Windows-tablet.');
      return;
    }
    let port;
    try { port = await navigator.serial.requestPort(); } catch (e) { return; }  // geannuleerd
    disconnect();
    let closed = false, reader = null;
    conn = {
      type: 'usb',
      close() { closed = true; if (reader) reader.cancel().catch(() => {}); },
    };
    try {
      await port.open({ baudRate: 115200 });
    } catch (e) {
      setConn('USB-poort bezet', 'bad');
      return;
    }
    setConn('USB', 'ok');
    settings.connection = 'usb';
    dirty = true;
    const decoder = new TextDecoder();
    try {
      while (!closed && port.readable) {
        reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.feed(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.releaseLock();
        }
      }
    } catch (e) {
      if (!closed) setConn('USB verbroken', 'bad');
    }
    try { await port.close(); } catch (e) { /* al dicht */ }
  }

  function connectDemo() {
    disconnect();
    const d = new demo.DemoTractor(text => parser.feed(text), { workWidth: settings.workWidth });
    d.start();
    conn = { type: 'demo', close() { d.stop(); } };
    setConn('Demo', 'warn');
    settings.connection = 'demo';
    dirty = true;
  }

  // ---------------------------------------------------------------- knoppen
  function toggleBoundary() {
    if (!recordingBoundary) {
      if (field.boundary.length && !confirm('De huidige grens vervangen door een nieuwe?')) return;
      field.boundary = [];
      cache.boundary = [];
      recordingBoundary = true;
      toast('Rij rond het perceel. Druk op "Grens stoppen" als je rond bent.');
    } else {
      recordingBoundary = false;
      if (field.boundary.length < 3) {
        field.boundary = [];
        cache.boundary = [];
        toast('Te weinig punten voor een grens.');
      } else {
        toast('Grens opgeslagen: ' + fmtHa(geo.polygonArea(cache.boundary)));
      }
    }
    dirty = true;
    updateButtons();
    updateInfo();
    requestDraw();
  }

  function toggleWork() {
    working = !working;
    if (working) {
      field.runs.push([]);
      cache.runs.push([]);
      lastLogT = 0;
    } else if (field.runs.length && field.runs[field.runs.length - 1].length < 2) {
      field.runs.pop();
      cache.runs.pop();
    }
    dirty = true;
    updateButtons();
    requestDraw();
  }

  function exportIsoxml() {
    if (!field.boundary.length && !field.log.length) {
      toast('Er is nog niets om te exporteren. Neem een grens op of werk het perceel.');
      return;
    }
    const files = isoxml.buildTaskData({
      customer: settings.customer, farm: settings.farm, field: settings.field,
      boundary: field.boundary, areaM2: geo.areaLatLon(field.boundary), log: field.log,
    });
    const data = zip.makeZip(files);
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const name = 'TASKDATA_' + (settings.field || 'perceel').replace(/[^\w-]+/g, '_') + '_' + stamp + '.zip';
    const url = URL.createObjectURL(new Blob([data], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Opgeslagen als ' + name + '. Pak uit en zet de map TASKDATA op de USB-stick.');
  }

  function newFieldClicked() {
    if ((field.boundary.length || field.log.length) &&
        !confirm('Alles van dit perceel wissen? Exporteer eerst als je het wilt bewaren.')) return;
    field = newField();
    frame = null;
    cache = { boundary: [], runs: [] };
    recordingBoundary = false;
    working = false;
    if (last) setFrame(last.lat, last.lon);
    dirty = true;
    save();
    updateButtons();
    updateInfo();
    requestDraw();
  }

  // ---------------------------------------------------------------- weergave
  function fmtHa(m2) { return (m2 / 10000).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ha'; }

  function setConn(text, cls) {
    const el = $('conn');
    el.textContent = text;
    el.className = 'pill' + (cls ? ' ' + cls : '');
  }

  function updateStatus() {
    const st = parser.state;
    const fix = $('fix');
    fix.textContent = nmea.QUALITY_NAMES[st.quality] || ('Fix ' + st.quality);
    fix.className = 'pill ' + (st.quality === 4 ? 'ok' : st.quality === 5 || st.quality === 2 ? 'warn' : st.quality === 1 ? 'warn' : 'bad');
    $('sats').innerHTML = 'Sat <b>' + (st.sats ?? '-') + '</b>';
    $('hdop').innerHTML = 'HDOP <b>' + (st.hdop ?? '-') + '</b>';
    $('speed').innerHTML = '<b>' + (st.speedKmh === null ? '-' : st.speedKmh.toFixed(1)) + '</b> km/u';
  }

  function updateInfo() {
    $('fieldName').textContent = settings.field || '-';
    $('areaField').textContent = field.boundary.length >= 3 ? fmtHa(geo.areaLatLon(field.boundary)) : '-';
    $('areaWorked').textContent = fmtHa(field.workedM2);
    $('widthInfo').textContent = settings.workWidth.toLocaleString('nl-BE') + ' m';
  }

  function updateButtons() {
    const b = $('btnBoundary');
    b.textContent = recordingBoundary ? 'Grens stoppen' : 'Grens opnemen';
    b.classList.toggle('rec', recordingBoundary);
    const w = $('btnWork');
    w.textContent = working ? 'Werk UIT' : 'Werk AAN';
    w.classList.toggle('on', working);
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
  }

  // ---------------------------------------------------------------- kaart tekenen
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  let drawPending = false;

  function requestDraw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => { drawPending = false; draw(); });
  }

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = view.scale;
    const sx = x => W / 2 + (x - view.cx) * s;
    const sy = y => H / 2 - (y - view.cy) * s;

    ctx.fillStyle = css('--map');
    ctx.fillRect(0, 0, W, H);

    // raster
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const grid = steps.find(g => g * s >= 60) || 1000;
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.floor((view.cx - W / 2 / s) / grid) * grid, x1 = view.cx + W / 2 / s;
    const y0 = Math.floor((view.cy - H / 2 / s) / grid) * grid, y1 = view.cy + H / 2 / s;
    for (let x = x0; x <= x1; x += grid) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), H); }
    for (let y = y0; y <= y1; y += grid) { ctx.moveTo(0, sy(y)); ctx.lineTo(W, sy(y)); }
    ctx.stroke();

    // bewerkte stroken
    ctx.strokeStyle = css('--cover');
    ctx.lineWidth = Math.max(1, settings.workWidth * s);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    for (const run of cache.runs) {
      if (run.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(sx(run[0].x), sy(run[0].y));
      for (let i = 1; i < run.length; i++) ctx.lineTo(sx(run[i].x), sy(run[i].y));
      ctx.stroke();
    }

    // perceelgrens
    const bnd = cache.boundary;
    if (bnd.length > 1) {
      ctx.beginPath();
      ctx.moveTo(sx(bnd[0].x), sy(bnd[0].y));
      for (let i = 1; i < bnd.length; i++) ctx.lineTo(sx(bnd[i].x), sy(bnd[i].y));
      if (recordingBoundary && last) {
        ctx.lineTo(sx(last.xy.x), sy(last.xy.y));
        ctx.setLineDash([10, 8]);
      } else {
        ctx.closePath();
        ctx.fillStyle = 'rgba(43, 138, 62, 0.08)';
        ctx.fill();
      }
      ctx.strokeStyle = css('--boundary');
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // tractor met werktuig
    if (last) {
      const px = sx(last.xy.x), py = sy(last.xy.y);
      const a = heading * Math.PI / 180;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(a);
      const half = settings.workWidth * s / 2;
      ctx.fillStyle = working ? css('--work') : css('--muted');
      ctx.fillRect(-half, 6, half * 2, Math.max(4, 0.6 * s));
      const L = Math.max(22, 5 * s), B = Math.max(14, 2.8 * s);
      ctx.beginPath();
      ctx.moveTo(0, -L * 0.6);
      ctx.lineTo(B / 2, L * 0.4);
      ctx.lineTo(-B / 2, L * 0.4);
      ctx.closePath();
      ctx.fillStyle = css('--accent');
      ctx.strokeStyle = css('--panel');
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = css('--muted');
      ctx.font = '600 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(conn ? 'Wachten op GPS-positie…' : 'Kies een verbinding bij Instellingen', W / 2, H / 2);
    }

    // schaalbalk
    const barM = steps.find(g => g * s >= 80) || 1000;
    ctx.fillStyle = css('--text');
    ctx.fillRect(16, H - 22, barM * s, 4);
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(barM + ' m', 16, H - 30);
  }

  // ---------------------------------------------------------------- aanraken en zoomen
  const pointers = new Map();
  let pinchStart = null;

  function zoom(factor) {
    view.scale = Math.min(80, Math.max(0.1, view.scale * factor));
    requestDraw();
  }

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      pinchStart = { d: Math.hypot(p.x - q.x, p.y - q.y), scale: view.scale };
    }
  });
  canvas.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) {
      view.follow = false;
      view.cx -= (cur.x - prev.x) / view.scale;
      view.cy += (cur.y - prev.y) / view.scale;
      requestDraw();
    } else if (pointers.size === 2 && pinchStart) {
      const [p, q] = [...pointers.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      view.scale = Math.min(80, Math.max(0.1, pinchStart.scale * d / pinchStart.d));
      requestDraw();
    }
  });
  const endPointer = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = null; };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2); }, { passive: false });

  // ---------------------------------------------------------------- instellingen
  const dlg = $('settings');

  function openSettings() {
    $('setField').value = settings.field;
    $('setCustomer').value = settings.customer;
    $('setFarm').value = settings.farm;
    $('setWidth').value = settings.workWidth;
    $('setHost').value = settings.host;
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function readSettings() {
    settings.field = $('setField').value.trim() || 'Perceel';
    settings.customer = $('setCustomer').value.trim();
    settings.farm = $('setFarm').value.trim();
    const w = parseFloat(String($('setWidth').value).replace(',', '.'));
    if (w > 0 && w <= 60) settings.workWidth = w;
    settings.host = $('setHost').value.trim();
    dirty = true;
    updateInfo();
    requestDraw();
  }

  dlg.addEventListener('close', readSettings);
  $('connWifi').onclick = () => { readSettings(); connectWifi(); dlg.close(); };
  $('connUsb').onclick = () => { readSettings(); connectUsb(); dlg.close(); };
  $('connDemo').onclick = () => { readSettings(); connectDemo(); dlg.close(); };
  $('clearBoundary').onclick = () => {
    if (!field.boundary.length || !confirm('De perceelgrens wissen?')) return;
    field.boundary = [];
    cache.boundary = [];
    recordingBoundary = false;
    dirty = true;
    updateButtons(); updateInfo(); requestDraw();
  };
  $('newField').onclick = () => { newFieldClicked(); dlg.close(); };

  $('btnBoundary').onclick = toggleBoundary;
  $('btnWork').onclick = toggleWork;
  $('btnExport').onclick = exportIsoxml;
  $('btnSettings').onclick = openSettings;
  $('zoomIn').onclick = () => zoom(1.5);
  $('zoomOut').onclick = () => zoom(1 / 1.5);
  $('center').onclick = () => {
    view.follow = true;
    if (last) { view.cx = last.xy.x; view.cy = last.xy.y; }
    requestDraw();
  };

  // ---------------------------------------------------------------- opstarten
  window.addEventListener('resize', requestDraw);
  window.addEventListener('pagehide', () => { dirty = true; save(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { dirty = true; save(); } });
  setInterval(save, 3000);
  setInterval(() => {
    if (conn && lastDataAt && Date.now() - lastDataAt > 3000) {
      const fix = $('fix');
      fix.textContent = 'Geen data';
      fix.className = 'pill bad';
    }
  }, 1000);

  // Scherm aan houden (alleen beschikbaar in een beveiligde context).
  async function keepAwake() {
    try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) { /* niet ondersteund */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
  keepAwake();

  load();
  updateStatus();
  updateInfo();
  updateButtons();
  requestDraw();

  // Geopend vanaf het GPS-kastje zelf: meteen via wifi verbinden.
  const servedByBox = location.protocol === 'http:' && location.hostname && location.hostname !== 'localhost' &&
    location.hostname !== '127.0.0.1';
  if (servedByBox || settings.connection === 'wifi') connectWifi();
  else if (settings.connection === 'demo') connectDemo();

  // Voor tests
  window.TG.appState = () => ({ settings, field, recordingBoundary, working, last, view });
})();
