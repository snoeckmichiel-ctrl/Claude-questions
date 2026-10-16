// app.js - het scherm: kaart, knoppen, verbinding met het GPS-kastje en opslaan.
(function () {
  'use strict';
  const { nmea, geo, isoxml, zip, demo, brand } = window.TG;
  const STORE_KEY = 'trekkergps.v1';
  const $ = id => document.getElementById(id);
  const nl = (n, d) => n.toLocaleString('nl-BE', { minimumFractionDigits: d, maximumFractionDigits: d });

  // ---------------------------------------------------------------- toestand
  const settings = { field: 'Perceel 1', customer: '', farm: '', workWidth: 12, host: '', connection: '', theme: 'auto' };

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
      toast('Opslaan op de tablet lukt niet. Exporteer het perceel.');
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

    if (!last) showWelcome(false);
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
    last = null;
  }

  function connectWifi() {
    disconnect();
    const host = settings.host || location.host || '192.168.4.1';
    let ws = null, closed = false, retry = null;
    const open = () => {
      setConn('Verbinden', 'off', 'i-wifi');
      try { ws = new WebSocket('ws://' + host + '/ws'); } catch (e) { ws = null; }
      if (!ws) { retry = setTimeout(open, 3000); return; }
      ws.onopen = () => setConn('Wifi', 'ok', 'i-wifi');
      ws.onmessage = ev => { if (typeof ev.data === 'string') parser.feed(ev.data); };
      ws.onclose = () => {
        if (closed) return;
        setConn('Verbroken', 'bad', 'i-wifi');
        retry = setTimeout(open, 2000);
      };
    };
    conn = { type: 'wifi', close() { closed = true; clearTimeout(retry); if (ws) ws.close(); } };
    settings.connection = 'wifi';
    dirty = true;
    showWelcome(true, 'Verbinden met het GPS-kastje', 'Zorg dat de tablet verbonden is met het wifinetwerk ' +
      'van het kastje (' + host + ').');
    open();
  }

  async function connectUsb() {
    if (!('serial' in navigator)) {
      toast('USB werkt in Chrome of Edge op een Windows-tablet of computer.');
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
      setConn('USB bezet', 'bad', 'i-usb');
      toast('De USB-poort is in gebruik door een ander programma.');
      return;
    }
    setConn('USB', 'ok', 'i-usb');
    settings.connection = 'usb';
    dirty = true;
    showWelcome(true, 'Wachten op GPS-signaal', 'Verbonden via USB.');
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
      if (!closed) setConn('USB los', 'bad', 'i-usb');
    }
    try { await port.close(); } catch (e) { /* al dicht */ }
  }

  function connectDemo() {
    disconnect();
    const d = new demo.DemoTractor(text => parser.feed(text), { workWidth: settings.workWidth });
    d.start();
    conn = { type: 'demo', close() { d.stop(); } };
    setConn('Demo', 'ok', 'i-demo');
    settings.connection = 'demo';
    dirty = true;
    showWelcome(true, 'Demo starten', 'Een gesimuleerde tractor rijdt een perceel af.');
  }

  // ---------------------------------------------------------------- vensters
  function ask(title, text, okLabel, danger) {
    const d = $('askDialog');
    $('askTitle').textContent = title;
    $('askText').textContent = text;
    const ok = $('askOk');
    ok.textContent = okLabel || 'OK';
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    d.returnValue = '';
    d.showModal();
    return new Promise(resolve => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
  }

  function showWelcome(show, title, text) {
    const w = $('welcome');
    w.classList.toggle('show', show);
    const waiting = show && !!conn;
    w.classList.toggle('waiting', waiting);
    $('welcomeOptions').hidden = waiting;
    $('welOther').hidden = !waiting;
    $('welcomeTitle').textContent = title || 'Verbind met je GPS';
    $('welcomeText').textContent = text || 'Kies hoe deze tablet het GPS-signaal ontvangt.';
  }

  // ---------------------------------------------------------------- knoppen
  async function toggleBoundary() {
    if (!recordingBoundary) {
      if (field.boundary.length &&
          !await ask('Nieuwe grens opnemen?', 'De huidige perceelgrens wordt vervangen.', 'Vervangen', true)) return;
      field.boundary = [];
      cache.boundary = [];
      recordingBoundary = true;
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

  function openExport() {
    if (!field.boundary.length && !field.log.length) {
      toast('Neem eerst een grens op of start het werk.');
      return;
    }
    $('expField').textContent = settings.field || '–';
    $('expCustomer').textContent = [settings.customer, settings.farm].filter(Boolean).join(', ') || '–';
    $('expArea').textContent = field.boundary.length >= 3 ? fmtHa(geo.areaLatLon(field.boundary)) : 'geen grens';
    $('expWorked').textContent = fmtHa(field.workedM2);
    const secs = field.log.length > 1 ? (field.log[field.log.length - 1].t - field.log[0].t) / 1000 : 0;
    $('expTrack').textContent = field.log.length ? nl(field.log.length, 0) + ' punten, ' + fmtDuration(secs) : 'geen';
    $('exportDialog').showModal();
  }

  function downloadIsoxml() {
    const files = isoxml.buildTaskData({
      customer: settings.customer, farm: settings.farm, field: settings.field,
      boundary: field.boundary, areaM2: geo.areaLatLon(field.boundary), log: field.log,
      software: brand.name, version: brand.version,
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
    $('exportDialog').close();
    toast('Opgeslagen als ' + name);
  }

  async function newFieldClicked() {
    if ((field.boundary.length || field.log.length) &&
        !await ask('Nieuw perceel beginnen?', 'De grens en het rijspoor van dit perceel worden gewist. ' +
          'Exporteer eerst als je ze wilt bewaren.', 'Wissen', true)) return;
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
  function fmtHa(m2) { return nl(m2 / 10000, 2) + ' ha'; }
  function fmtDuration(s) {
    const m = Math.round(s / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' u ' + String(m % 60).padStart(2, '0');
  }

  function setConn(text, state, icon) {
    const el = $('conn');
    el.dataset.state = state;
    el.querySelector('use').setAttribute('href', '#' + (icon || 'i-wifi'));
    $('connLabel').textContent = text;
  }

  function qualityClass(q) {
    if (q === 4) return 'good';
    if (q === 5 || q === 2) return 'fair';
    if (q === 1 || q === 3 || q === 6) return 'poor';
    return 'none';
  }

  function updateStatus() {
    const st = parser.state;
    const fix = $('fix');
    fix.textContent = nmea.QUALITY_NAMES[st.quality] || ('Fix ' + st.quality);
    fix.dataset.q = qualityClass(st.quality);
    fix.title = 'HDOP ' + (st.hdop ?? '–');
    $('satsValue').textContent = st.sats ?? '–';
    $('speedValue').textContent = st.speedKmh === null ? '0,0' : nl(st.speedKmh, 1);
  }

  function updateInfo() {
    $('fieldName').textContent = settings.field || 'Perceel';
    $('areaField').textContent = field.boundary.length >= 3 ? fmtHa(geo.areaLatLon(field.boundary)) : '–';
    $('areaWorked').textContent = fmtHa(field.workedM2);
    $('widthInfo').textContent = nl(settings.workWidth, settings.workWidth % 1 ? 1 : 0) + ' m';
  }

  function updateButtons() {
    $('btnBoundary').classList.toggle('active', recordingBoundary);
    $('banner').classList.toggle('show', recordingBoundary);
    const w = $('btnWork');
    w.classList.toggle('on', working);
    w.querySelector('use').setAttribute('href', working ? '#i-stop' : '#i-play');
    w.querySelector('span').textContent = working ? 'Stop werk' : 'Start werk';
    $('center').classList.toggle('active', view.follow);
  }

  function applyTheme() {
    if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme;
    else delete document.documentElement.dataset.theme;
    document.querySelectorAll('#themeSel button').forEach(b => b.classList.toggle('selected', b.dataset.theme === settings.theme));
    requestDraw();
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
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

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

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
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
    const grid = steps.find(g => g * s >= 70) || 2000;
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.floor((view.cx - W / 2 / s) / grid) * grid, x1 = view.cx + W / 2 / s;
    const y0 = Math.floor((view.cy - H / 2 / s) / grid) * grid, y1 = view.cy + H / 2 / s;
    for (let x = x0; x <= x1; x += grid) { const px = Math.round(sx(x)) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, H); }
    for (let y = y0; y <= y1; y += grid) { const py = Math.round(sy(y)) + 0.5; ctx.moveTo(0, py); ctx.lineTo(W, py); }
    ctx.stroke();

    // perceel invullen
    const bnd = cache.boundary;
    if (bnd.length > 2 && !recordingBoundary) {
      ctx.beginPath();
      ctx.moveTo(sx(bnd[0].x), sy(bnd[0].y));
      for (let i = 1; i < bnd.length; i++) ctx.lineTo(sx(bnd[i].x), sy(bnd[i].y));
      ctx.closePath();
      ctx.fillStyle = css('--field-fill');
      ctx.fill();
    }

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
    if (bnd.length > 1) {
      ctx.beginPath();
      ctx.moveTo(sx(bnd[0].x), sy(bnd[0].y));
      for (let i = 1; i < bnd.length; i++) ctx.lineTo(sx(bnd[i].x), sy(bnd[i].y));
      if (recordingBoundary && last) ctx.lineTo(sx(last.xy.x), sy(last.xy.y));
      else ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.strokeStyle = css('--surface');
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = css('--boundary');
      ctx.lineWidth = 3;
      if (recordingBoundary) ctx.setLineDash([12, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // tractor met werktuig
    if (last) {
      const px = sx(last.xy.x), py = sy(last.xy.y);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(heading * Math.PI / 180);
      const m = Math.max(s, 9);               // tractor altijd goed zichtbaar
      const half = settings.workWidth * s / 2;
      // werktuig achter de tractor
      ctx.strokeStyle = css('--muted');
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 1.6 * m); ctx.lineTo(0, 2.6 * m); ctx.stroke();
      ctx.fillStyle = working ? css('--work') : css('--muted');
      roundRect(-half, 2.6 * m, half * 2, Math.max(5, 0.7 * m), 2);
      ctx.fill();
      // tractor: carrosserie en cabine, neus naar boven
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = css('--brand');
      roundRect(-1.1 * m, -2.4 * m, 2.2 * m, 4.0 * m, 0.5 * m);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = css('--surface');
      roundRect(-0.75 * m, -0.1 * m, 1.5 * m, 1.3 * m, 0.25 * m);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -3.3 * m); ctx.lineTo(0.7 * m, -2.5 * m); ctx.lineTo(-0.7 * m, -2.5 * m); ctx.closePath();
      ctx.fillStyle = css('--brand-2');
      ctx.fill();
      ctx.restore();
    }

    // schaalbalk
    const barM = steps.find(g => g * s >= 70) || 2000;
    $('scaleLabel').textContent = barM >= 1000 ? (barM / 1000) + ' km' : barM + ' m';
    $('scaleBar').style.width = Math.round(barM * s) + 'px';
  }

  // ---------------------------------------------------------------- aanraken en zoomen
  const pointers = new Map();
  let pinchStart = null;

  function zoom(factor) {
    view.scale = Math.min(80, Math.max(0.05, view.scale * factor));
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
      if (view.follow && Math.hypot(cur.x - prev.x, cur.y - prev.y) < 1) return;
      view.follow = false;
      $('center').classList.remove('active');
      view.cx -= (cur.x - prev.x) / view.scale;
      view.cy += (cur.y - prev.y) / view.scale;
      requestDraw();
    } else if (pointers.size === 2 && pinchStart) {
      const [p, q] = [...pointers.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      view.scale = Math.min(80, Math.max(0.05, pinchStart.scale * d / pinchStart.d));
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
    document.querySelectorAll('#settings .opt').forEach(b =>
      b.classList.toggle('selected', conn && b.id === 'conn' + conn.type[0].toUpperCase() + conn.type.slice(1)));
    applyTheme();
    dlg.showModal();
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

  function renderAbout() {
    const el = $('aboutText');
    el.textContent = '';
    const line = (txt, bold) => {
      const div = document.createElement('div');
      if (bold) { const b = document.createElement('b'); b.textContent = txt; div.appendChild(b); } else div.textContent = txt;
      el.appendChild(div);
    };
    line(brand.name + ' ' + brand.version, true);
    if (brand.company) line(brand.company);
    line('ISOXML-export volgens ISO 11783-10, versie 3.');
    line(brand.credits);
  }

  dlg.addEventListener('close', readSettings);
  $('connWifi').onclick = () => { readSettings(); dlg.close(); connectWifi(); };
  $('connUsb').onclick = () => { readSettings(); dlg.close(); connectUsb(); };
  $('connDemo').onclick = () => { readSettings(); dlg.close(); connectDemo(); };
  document.querySelectorAll('#themeSel button').forEach(b => {
    b.onclick = () => { settings.theme = b.dataset.theme; dirty = true; applyTheme(); };
  });
  $('clearBoundary').onclick = async () => {
    if (!field.boundary.length) { toast('Er is geen grens om te wissen.'); return; }
    dlg.close();
    if (!await ask('Grens wissen?', 'De perceelgrens wordt verwijderd. Het rijspoor blijft bewaard.', 'Wissen', true)) return;
    field.boundary = [];
    cache.boundary = [];
    recordingBoundary = false;
    dirty = true;
    updateButtons(); updateInfo(); requestDraw();
  };
  $('newField').onclick = () => { dlg.close(); newFieldClicked(); };

  $('welWifi').onclick = connectWifi;
  $('welUsb').onclick = connectUsb;
  $('welDemo').onclick = connectDemo;
  $('welOther').onclick = () => { disconnect(); setConn('Offline', 'off', 'i-wifi'); showWelcome(true); };

  $('btnBoundary').onclick = toggleBoundary;
  $('bannerDone').onclick = toggleBoundary;
  $('btnWork').onclick = toggleWork;
  $('btnExport').onclick = openExport;
  $('exportDownload').onclick = downloadIsoxml;
  $('btnSettings').onclick = openSettings;
  $('fieldBtn').onclick = () => { openSettings(); $('setField').focus(); };
  $('zoomIn').onclick = () => zoom(1.5);
  $('zoomOut').onclick = () => zoom(1 / 1.5);
  $('center').onclick = () => {
    view.follow = true;
    if (last) { view.cx = last.xy.x; view.cy = last.xy.y; }
    updateButtons();
    requestDraw();
  };

  // ---------------------------------------------------------------- opstarten
  window.addEventListener('resize', requestDraw);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', requestDraw);
  window.addEventListener('pagehide', () => { dirty = true; save(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { dirty = true; save(); } });
  setInterval(save, 3000);
  setInterval(() => {
    if (conn && lastDataAt && Date.now() - lastDataAt > 3000) {
      const fix = $('fix');
      fix.textContent = 'Geen signaal';
      fix.dataset.q = 'none';
    }
  }, 1000);

  // Scherm aan houden (alleen beschikbaar in een beveiligde context).
  async function keepAwake() {
    try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) { /* niet ondersteund */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
  keepAwake();

  document.title = brand.name;
  $('brandName').textContent = brand.name;
  load();
  applyTheme();
  renderAbout();
  updateStatus();
  updateInfo();
  updateButtons();
  requestDraw();

  // Geopend vanaf het GPS-kastje zelf: meteen via wifi verbinden.
  const servedByBox = location.protocol === 'http:' && location.hostname && location.hostname !== 'localhost' &&
    location.hostname !== '127.0.0.1';
  if (servedByBox || settings.connection === 'wifi') connectWifi();
  else if (settings.connection === 'demo') connectDemo();
  else showWelcome(true);

  // Voor tests
  window.TG.appState = () => ({ settings, field, recordingBoundary, working, last, view });
})();
