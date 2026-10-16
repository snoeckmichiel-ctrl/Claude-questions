// app.js - het scherm: kaart, knoppen, verbindingen, percelen en opslag.
(function () {
  'use strict';
  const T = window.TG;
  const { nmea, geo, isoxml, zip, demo, brand } = T;
  const $ = id => document.getElementById(id);
  const nl = (n, d) => n.toLocaleString('nl-BE', { minimumFractionDigits: d, maximumFractionDigits: d });
  const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';  // Nordic UART-dienst
  const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
  const LEGACY_KEY = 'trekkergps.v1';

  // ---------------------------------------------------------------- toestand
  const settings = {
    defaultWidth: 12, host: '', boxHost: '', connection: '', theme: 'auto',
    driveUrl: '', driveKey: '', bleId: '', lastCustomer: '', lastFarm: '',
  };
  const store = new T.store.Store(geo);
  const sync = new T.sync.DriveSync({
    store, isoxml, zip, geo, brand,
    getConfig: () => ({ url: settings.driveUrl, key: settings.driveKey }),
    onStatus: setSyncStatus,
  });

  let job = null;                         // het perceel waar je nu op werkt
  let frame = null;                       // omrekening GPS naar meters
  let cache = { boundary: [], runs: [] }; // dezelfde punten in meters
  let recordingBoundary = false;
  let working = false;
  let last = null;                        // laatste positie
  let heading = 0;
  let lastLogT = 0;
  let lastDataAt = 0;
  let dirty = false;
  let saving = false;
  const view = { scale: 3, cx: 0, cy: 0, follow: true };

  const parser = new nmea.NmeaParser(onPosition);

  // ---------------------------------------------------------------- opslaan
  function changed() {
    job.updatedAt = Date.now();
    dirty = true;
  }

  async function saveJob() {
    if (!dirty || saving || !job) return;
    saving = true;
    dirty = false;
    try {
      await store.putJob(job);
    } catch (e) {
      dirty = true;
      toast('Opslaan op de tablet mislukt. Exporteer het perceel.');
    } finally {
      saving = false;
    }
  }

  function saveSettings() {
    store.setKV('settings', settings).catch(() => {});
  }

  // Gegevens uit de eerste versie van de app overnemen.
  async function migrateLegacy() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); } catch (e) { return; }
    if (!data) return;
    const f = data.field || {};
    if ((f.boundary && f.boundary.length) || (f.log && f.log.length)) {
      const s = data.settings || {};
      const j = T.store.createJob({
        name: s.field || 'Perceel', customer: s.customer || '', farm: s.farm || '',
        workWidth: s.workWidth || 12, origin: f.origin || null, boundary: f.boundary || [],
        runs: f.runs || [], log: f.log || [], workedM2: f.workedM2 || 0,
      });
      await store.putJob(j);
      await store.setKV('currentJobId', j.id);
    }
    try { localStorage.removeItem(LEGACY_KEY); } catch (e) { /* geen toegang */ }
  }

  function setFrame(lat, lon) {
    frame = new geo.LocalFrame(lat, lon);
    job.origin = { lat, lon };
    cache.boundary = job.boundary.map(p => frame.toXY(p.lat, p.lon));
    cache.runs = job.runs.map(run => run.map(p => frame.toXY(p.lat, p.lon)));
  }

  function loadJobIntoView(j) {
    job = j;
    frame = null;
    cache = { boundary: [], runs: [] };
    recordingBoundary = false;
    working = false;
    if (job.origin) setFrame(job.origin.lat, job.origin.lon);
    else if (last) setFrame(last.lat, last.lon);
    if (last && frame) last.xy = frame.toXY(last.lat, last.lon);
    // Kaart op het perceel zetten als er nog geen positie is.
    const pts = cache.boundary.length ? cache.boundary : (cache.runs.find(r => r.length) || []);
    if (!last && pts.length) { view.cx = pts[0].x; view.cy = pts[0].y; }
    if (last) { view.follow = true; view.cx = last.xy.x; view.cy = last.xy.y; }
    store.setKV('currentJobId', job.id).catch(() => {});
    updateButtons();
    updateInfo();
    requestDraw();
  }

  function createJob() {
    return T.store.createJob({
      name: 'Perceel ' + new Date().toLocaleDateString('nl-BE', { day: 'numeric', month: 'numeric' }),
      customer: settings.lastCustomer, farm: settings.lastFarm, workWidth: settings.defaultWidth,
    });
  }

  // ---------------------------------------------------------------- GPS
  function onPosition(pos) {
    if (!frame) setFrame(pos.lat, pos.lon);
    const xy = frame.toXY(pos.lat, pos.lon);
    const ll = { lat: +pos.lat.toFixed(9), lon: +pos.lon.toFixed(9) };

    if (pos.speedKmh !== null && pos.speedKmh > 0.5 && pos.course !== null) heading = pos.course;
    else if (last && last.xy && geo.distance(last.xy, xy) > 0.3) {
      heading = (Math.atan2(xy.x - last.xy.x, xy.y - last.xy.y) * 180 / Math.PI + 360) % 360;
    }

    if (recordingBoundary) {
      const lb = cache.boundary[cache.boundary.length - 1];
      if (!lb || geo.distance(lb, xy) >= 1) {
        job.boundary.push(ll);
        cache.boundary.push(xy);
        changed();
      }
    }

    if (working) {
      const run = job.runs[job.runs.length - 1];
      const runXY = cache.runs[cache.runs.length - 1];
      const lp = runXY[runXY.length - 1];
      const d = lp ? geo.distance(lp, xy) : 0;
      if (!lp || d >= 0.5) {
        if (lp && d < 50) job.workedM2 += d * job.workWidth;  // grote sprong = GPS-fout
        run.push(ll);
        runXY.push(xy);
        changed();
      }
      const now = Date.now();
      if (now - lastLogT >= 900) {  // ongeveer 1 per seconde, met marge voor schommelingen
        job.log.push({ t: now, lat: ll.lat, lon: ll.lon, quality: pos.quality });
        lastLogT = now;
        changed();
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

  function useConnection(type) {
    settings.connection = type;
    saveSettings();
  }

  async function connectBle(knownDevice) {
    if (!navigator.bluetooth) {
      toast('Bluetooth werkt in Chrome op Android, Windows of een Chromebook, via de online app.');
      return;
    }
    let device = knownDevice;
    if (!device) {
      try {
        device = await navigator.bluetooth.requestDevice({ filters: [{ services: [NUS_SERVICE] }] });
      } catch (e) { return; }  // geannuleerd
    }
    disconnect();
    let closed = false, retry = null, ch = null;
    const decoder = new TextDecoder();
    const onData = ev => parser.feed(decoder.decode(ev.target.value, { stream: true }));
    const onLost = () => {
      if (closed) return;
      setConn('Verbroken', 'bad', 'i-bt');
      retry = setTimeout(open, 2000);
    };
    const open = async () => {
      if (closed) return;
      setConn('Verbinden', 'off', 'i-bt');
      try {
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(NUS_SERVICE);
        if (ch) ch.removeEventListener('characteristicvaluechanged', onData);
        ch = await service.getCharacteristic(NUS_TX);
        ch.addEventListener('characteristicvaluechanged', onData);
        await ch.startNotifications();
        setConn('Bluetooth', 'ok', 'i-bt');
      } catch (e) {
        if (!closed) { setConn('Zoeken', 'bad', 'i-bt'); retry = setTimeout(open, 3000); }
      }
    };
    device.addEventListener('gattserverdisconnected', onLost);
    conn = {
      type: 'ble',
      close() {
        closed = true;
        clearTimeout(retry);
        device.removeEventListener('gattserverdisconnected', onLost);
        if (device.gatt.connected) device.gatt.disconnect();
      },
    };
    settings.bleId = device.id;
    useConnection('ble');
    showWelcome(true, 'Verbinden via Bluetooth', 'Zet het GPS-kastje aan en houd de tablet in de buurt.');
    open();
  }

  // Bekend Bluetooth-kastje opnieuw verbinden zonder keuzevenster, als de browser dat toelaat.
  async function reconnectBle() {
    try {
      if (navigator.bluetooth && navigator.bluetooth.getDevices) {
        const devices = await navigator.bluetooth.getDevices();
        const d = devices.find(x => x.id === settings.bleId) || devices[0];
        if (d) { connectBle(d); return true; }
      }
    } catch (e) { /* niet ondersteund */ }
    return false;
  }

  // Via de hotspot van de tablet (of het eigen wifinetwerk van het kastje).
  function connectHotspot() {
    disconnect();
    const servedByBox = location.protocol === 'http:' && location.hostname &&
      !['localhost', '127.0.0.1'].includes(location.hostname);
    const known = [settings.host, servedByBox ? location.host : '', settings.boxHost, '192.168.4.1'];
    const link = new T.box.BoxLink({
      onText: text => parser.feed(text),
      whereis: async () => {
        if (!sync.configured()) return null;
        const r = await sync.call({ action: 'whereis' });
        return r.box && r.box.ip;
      },
      onState: (st, detail) => {
        if (st === 'ok') {
          setConn('Hotspot', 'ok', 'i-wifi');
          if (detail && detail !== settings.boxHost) { settings.boxHost = detail; saveSettings(); }
          if (!last) showWelcome(true, 'Wachten op GPS-signaal', 'Verbonden met het kastje op ' + detail + '.');
        } else if (st === 'searching') {
          setConn('Zoeken', 'off', 'i-wifi');
          if (!last) showWelcome(true, 'GPS-kastje zoeken', detail + '. Chrome kan vragen of de app apparaten ' +
            'in je netwerk mag gebruiken: kies Toestaan.');
        } else if (st === 'notfound') {
          setConn('Niet gevonden', 'bad', 'i-wifi');
          if (!last) showWelcome(true, 'Kastje niet gevonden', 'Zet de hotspot van de tablet aan en het kastje ' +
            'daarna. De app blijft zoeken.');
        } else if (st === 'lost') {
          setConn('Verbroken', 'bad', 'i-wifi');
        } else if (st === 'connecting') {
          setConn('Verbinden', 'off', 'i-wifi');
        }
      },
    });
    conn = { type: 'hotspot', close() { link.close(); } };
    useConnection('hotspot');
    showWelcome(true, 'GPS-kastje zoeken', 'Even geduld.');
    link.start(known);
  }

  async function connectUsb() {
    if (!('serial' in navigator)) {
      toast('USB werkt in Chrome of Edge op een Windows-tablet of computer.');
      return;
    }
    let port;
    try { port = await navigator.serial.requestPort(); } catch (e) { return; }
    disconnect();
    let closed = false, reader = null;
    conn = { type: 'usb', close() { closed = true; if (reader) reader.cancel().catch(() => {}); } };
    try {
      await port.open({ baudRate: 115200 });
    } catch (e) {
      setConn('USB bezet', 'bad', 'i-usb');
      toast('De USB-poort is in gebruik door een ander programma.');
      return;
    }
    setConn('USB', 'ok', 'i-usb');
    useConnection('usb');
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
    const d = new demo.DemoTractor(text => parser.feed(text), { workWidth: job.workWidth });
    d.start();
    conn = { type: 'demo', close() { d.stop(); } };
    setConn('Demo', 'ok', 'i-demo');
    useConnection('demo');
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
      if (job.boundary.length &&
          !await ask('Nieuwe grens opnemen?', 'De huidige perceelgrens wordt vervangen.', 'Vervangen', true)) return;
      job.boundary = [];
      cache.boundary = [];
      recordingBoundary = true;
    } else {
      recordingBoundary = false;
      if (job.boundary.length < 3) {
        job.boundary = [];
        cache.boundary = [];
        toast('Te weinig punten voor een grens.');
      } else {
        toast('Grens opgeslagen: ' + fmtHa(geo.polygonArea(cache.boundary)));
      }
      syncSoon();
    }
    changed();
    updateButtons();
    updateInfo();
    requestDraw();
  }

  function toggleWork() {
    working = !working;
    if (working) {
      job.runs.push([]);
      cache.runs.push([]);
      lastLogT = 0;
    } else {
      if (job.runs.length && job.runs[job.runs.length - 1].length < 2) {
        job.runs.pop();
        cache.runs.pop();
      }
      syncSoon();
    }
    changed();
    updateButtons();
    requestDraw();
  }

  // ---------------------------------------------------------------- percelen
  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function iconButton(icon, label, onClick) {
    const b = el('button', 'icon-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = '<svg class="ic"><use href="#' + icon + '"/></svg>';
    b.onclick = onClick;
    return b;
  }

  async function renderJobs() {
    await saveJob();
    const list = await store.listJobs();
    const box = $('jobList');
    box.textContent = '';
    if (!list.length) box.appendChild(el('p', 'empty', 'Nog geen percelen.'));
    for (const s of list) {
      const row = el('div', 'job' + (s.id === job.id ? ' current' : ''));
      row.dataset.id = s.id;
      const info = el('div');
      const h = el('h4', '', s.name || 'Perceel');
      if (s.id === job.id) h.appendChild(el('span', 'badge active', 'Actief'));
      if (sync.configured()) {
        const inDrive = s.syncedAt && s.syncedAt >= s.updatedAt;
        h.appendChild(el('span', 'badge ' + (inDrive ? 'ok' : 'wait'), inDrive ? 'In Drive' : 'Wacht op Drive'));
      }
      info.appendChild(h);
      const who = [s.customer, s.farm].filter(Boolean).join(', ');
      info.appendChild(el('div', 'meta', [fmtDate(s.createdAt), who].filter(Boolean).join(' · ')));
      info.appendChild(el('div', 'meta', (s.areaM2 ? fmtHa(s.areaM2) + ' perceel · ' : '') + fmtHa(s.workedM2) + ' bewerkt'));
      row.appendChild(info);
      const btns = el('div', 'btns');
      if (s.id !== job.id) {
        const open = el('button', 'btn open', 'Openen');
        open.type = 'button';
        open.onclick = () => openJob(s.id);
        btns.appendChild(open);
      }
      const exp = iconButton('i-export', 'ISOXML exporteren', () => openExport(s.id));
      exp.classList.add('exp');
      btns.appendChild(exp);
      const del = iconButton('i-trash', 'Verwijderen', () => deleteJob(s.id, s.name));
      del.classList.add('del');
      btns.appendChild(del);
      row.appendChild(btns);
      box.appendChild(row);
    }
    $('remoteSection').hidden = !sync.configured();
    $('remoteList').textContent = '';
  }

  async function openJobs() {
    await renderJobs();
    $('jobsDialog').showModal();
  }

  async function openJob(id) {
    await saveJob();
    const j = await store.getJob(id);
    if (!j) { toast('Perceel niet gevonden.'); return; }
    loadJobIntoView(j);
    $('jobsDialog').close();
    toast(j.name + ' geopend');
  }

  async function newJob() {
    await saveJob();
    const j = createJob();
    await store.putJob(j);
    loadJobIntoView(j);
    $('jobsDialog').close();
    openSettings();
    $('setField').select();
  }

  async function deleteJob(id, name) {
    const inDrive = sync.configured() ? ' De kopie in Google Drive blijft bewaard.' : '';
    if (!await ask('"' + (name || 'Perceel') + '" verwijderen?', 'Het perceel wordt van deze tablet gewist.' + inDrive,
      'Verwijderen', true)) return;
    await store.deleteJob(id);
    if (id === job.id) {
      const j = createJob();
      await store.putJob(j);
      loadJobIntoView(j);
    }
    await renderJobs();
  }

  async function showRemote() {
    const box = $('remoteList');
    box.textContent = '';
    box.appendChild(el('p', 'hint', 'Ophalen uit Drive…'));
    let list;
    try {
      list = await sync.listRemote();
    } catch (e) {
      box.textContent = '';
      box.appendChild(el('p', 'hint bad', 'Drive niet bereikbaar: ' + e.message));
      return;
    }
    box.textContent = '';
    if (!list.length) { box.appendChild(el('p', 'empty', 'Alle percelen uit Drive staan al op deze tablet.')); return; }
    for (const r of list) {
      const row = el('div', 'job');
      const info = el('div');
      info.appendChild(el('h4', '', r.name || 'Perceel'));
      info.appendChild(el('div', 'meta', [r.createdAt ? fmtDate(r.createdAt) : '', r.customer].filter(Boolean).join(' · ')));
      info.appendChild(el('div', 'meta', fmtHa(r.workedM2 || 0) + ' bewerkt'));
      row.appendChild(info);
      const b = el('button', 'btn restore', 'Ophalen');
      b.type = 'button';
      b.onclick = async () => {
        b.disabled = true;
        try {
          await sync.restore(r.id);
          toast(r.name + ' staat weer op de tablet');
          await renderJobs();
        } catch (e) {
          b.disabled = false;
          toast('Ophalen mislukt: ' + e.message);
        }
      };
      const btns = el('div', 'btns');
      btns.appendChild(b);
      row.appendChild(btns);
      box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- export
  let exportJob = null;

  async function openExport(id) {
    await saveJob();
    const j = !id || id === job.id ? job : await store.getJob(id);
    if (!j || (!j.boundary.length && !j.log.length)) {
      toast('Dit perceel heeft nog geen grens of rijspoor.');
      return;
    }
    exportJob = j;
    if ($('jobsDialog').open) $('jobsDialog').close();
    $('expField').textContent = j.name || '–';
    $('expCustomer').textContent = [j.customer, j.farm].filter(Boolean).join(', ') || '–';
    $('expArea').textContent = j.boundary.length >= 3 ? fmtHa(geo.areaLatLon(j.boundary)) : 'geen grens';
    $('expWorked').textContent = fmtHa(j.workedM2);
    const secs = j.log.length > 1 ? (j.log[j.log.length - 1].t - j.log[0].t) / 1000 : 0;
    $('expTrack').textContent = j.log.length ? nl(j.log.length, 0) + ' punten, ' + fmtDuration(secs) : 'geen';
    $('exportDialog').showModal();
  }

  function downloadIsoxml() {
    const j = exportJob || job;
    const files = isoxml.buildTaskData({
      customer: j.customer, farm: j.farm, field: j.name,
      boundary: j.boundary, areaM2: geo.areaLatLon(j.boundary), log: j.log,
      software: brand.name, version: brand.version,
    });
    const data = zip.makeZip(files);
    const d = new Date(j.createdAt);
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const name = 'TASKDATA_' + T.sync.safeName(j.name) + '_' + stamp + '.zip';
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

  // ---------------------------------------------------------------- Drive
  let syncTimer = null;
  function syncSoon() {
    if (!sync.configured()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => { await saveJob(); sync.syncAll(); }, 3000);
  }

  function setSyncStatus(text, state) {
    const chip = $('sync');
    chip.hidden = !sync.configured();
    chip.dataset.state = state;
    chip.title = text;
    $('syncLabel').textContent = state === 'busy' ? 'Opslaan…' : state === 'bad' ? 'Drive fout' :
      state === 'off' ? 'Offline' : 'Drive';
    const st = $('driveStatus');
    if (st) { st.textContent = text; st.className = 'hint ' + (state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : ''); }
  }

  async function driveTest() {
    readSettings();
    if (!sync.configured()) { setSyncStatus('Vul het adres van de Drive-koppeling in (begint met https://).', 'bad'); return; }
    setSyncStatus('Verbinding testen…', 'busy');
    try {
      await sync.ping();
      setSyncStatus('Verbonden met Google Drive.', 'ok');
    } catch (e) {
      setSyncStatus('Geen verbinding: ' + e.message, 'bad');
    }
  }

  async function driveSyncNow() {
    readSettings();
    if (!sync.configured()) { setSyncStatus('Vul eerst het adres van de Drive-koppeling in.', 'bad'); return; }
    await saveJob();
    const r = await sync.syncAll();
    if (!sync.lastError) setSyncStatus(r.sent ? (r.sent === 1 ? '1 perceel' : r.sent + ' percelen') + ' opgeslagen in Drive.' : 'Alles staat al in Drive.', 'ok');
  }

  // ---------------------------------------------------------------- weergave
  function fmtHa(m2) { return nl(m2 / 10000, 2) + ' ha'; }
  function fmtDuration(s) {
    const m = Math.round(s / 60);
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' u ' + String(m % 60).padStart(2, '0');
  }

  function setConn(text, state, icon) {
    const c = $('conn');
    c.dataset.state = state;
    c.querySelector('use').setAttribute('href', '#' + (icon || 'i-wifi'));
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
    if (!job) return;
    $('fieldName').textContent = job.name || 'Perceel';
    $('areaField').textContent = job.boundary.length >= 3 ? fmtHa(geo.areaLatLon(job.boundary)) : '–';
    $('areaWorked').textContent = fmtHa(job.workedM2);
    $('widthInfo').textContent = nl(job.workWidth, job.workWidth % 1 ? 1 : 0) + ' m';
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
    if (!job) return;
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
    ctx.lineWidth = Math.max(1, job.workWidth * s);
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
      if (recordingBoundary && last && last.xy) ctx.lineTo(sx(last.xy.x), sy(last.xy.y));
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
    if (last && last.xy) {
      const px = sx(last.xy.x), py = sy(last.xy.y);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(heading * Math.PI / 180);
      const m = Math.max(s, 9);               // tractor altijd goed zichtbaar
      const half = job.workWidth * s / 2;
      ctx.strokeStyle = css('--muted');
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 1.6 * m); ctx.lineTo(0, 2.6 * m); ctx.stroke();
      ctx.fillStyle = working ? css('--work') : css('--muted');
      roundRect(-half, 2.6 * m, half * 2, Math.max(5, 0.7 * m), 2);
      ctx.fill();
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
    $('setField').value = job.name;
    $('setCustomer').value = job.customer;
    $('setFarm').value = job.farm;
    $('setWidth').value = job.workWidth;
    $('setHost').value = settings.host;
    $('setDriveUrl').value = settings.driveUrl;
    $('setDriveKey').value = settings.driveKey;
    document.querySelectorAll('#settings .opt').forEach(b => {
      const t = conn ? conn.type : '';
      b.classList.toggle('selected', b.id === 'conn' + t.charAt(0).toUpperCase() + t.slice(1));
    });
    applyTheme();
    if (!sync.configured()) setSyncStatus('Nog niet ingesteld. De percelen blijven op deze tablet bewaard.', 'off');
    dlg.showModal();
  }

  function readSettings() {
    const name = $('setField').value.trim() || 'Perceel';
    const customer = $('setCustomer').value.trim();
    const farm = $('setFarm').value.trim();
    const w = parseFloat(String($('setWidth').value).replace(',', '.'));
    if (name !== job.name || customer !== job.customer || farm !== job.farm || (w > 0 && w <= 60 && w !== job.workWidth)) {
      job.name = name;
      job.customer = customer;
      job.farm = farm;
      if (w > 0 && w <= 60) job.workWidth = w;
      changed();
    }
    settings.lastCustomer = customer;
    settings.lastFarm = farm;
    settings.defaultWidth = job.workWidth;
    settings.host = $('setHost').value.trim();
    settings.driveUrl = $('setDriveUrl').value.trim();
    settings.driveKey = $('setDriveKey').value;
    saveSettings();
    $('sync').hidden = !sync.configured();
    updateInfo();
    requestDraw();
  }

  function renderAbout() {
    const box = $('aboutText');
    box.textContent = '';
    const line = (txt, bold) => {
      const div = document.createElement('div');
      if (bold) { const b = document.createElement('b'); b.textContent = txt; div.appendChild(b); } else div.textContent = txt;
      box.appendChild(div);
    };
    line(brand.name + ' ' + brand.version, true);
    if (brand.company) line(brand.company);
    line(store.durable ? (store.persisted ? 'Percelen worden blijvend op deze tablet bewaard.'
      : 'Percelen worden op deze tablet bewaard.') : 'Let op: deze browser bewaart geen gegevens.');
    line('ISOXML-export volgens ISO 11783-10, versie 3.');
    line(brand.credits);
  }

  dlg.addEventListener('close', readSettings);
  $('connBle').onclick = () => { readSettings(); dlg.close(); connectBle(); };
  $('connHotspot').onclick = () => { readSettings(); dlg.close(); connectHotspot(); };
  $('connUsb').onclick = () => { readSettings(); dlg.close(); connectUsb(); };
  $('connDemo').onclick = () => { readSettings(); dlg.close(); connectDemo(); };
  document.querySelectorAll('#themeSel button').forEach(b => {
    b.onclick = () => { settings.theme = b.dataset.theme; saveSettings(); applyTheme(); };
  });
  $('clearBoundary').onclick = async () => {
    if (!job.boundary.length) { toast('Er is geen grens om te wissen.'); return; }
    dlg.close();
    if (!await ask('Grens wissen?', 'De perceelgrens wordt verwijderd. Het rijspoor blijft bewaard.', 'Wissen', true)) return;
    job.boundary = [];
    cache.boundary = [];
    recordingBoundary = false;
    changed();
    updateButtons(); updateInfo(); requestDraw();
  };
  $('driveTest').onclick = driveTest;
  $('driveSync').onclick = driveSyncNow;

  $('welBle').onclick = () => connectBle();
  $('welHotspot').onclick = connectHotspot;
  $('welUsb').onclick = connectUsb;
  $('welDemo').onclick = connectDemo;
  $('welOther').onclick = () => { disconnect(); setConn('Offline', 'off', 'i-wifi'); showWelcome(true); };

  $('btnBoundary').onclick = toggleBoundary;
  $('bannerDone').onclick = toggleBoundary;
  $('btnWork').onclick = toggleWork;
  $('btnJobs').onclick = openJobs;
  $('newJob').onclick = newJob;
  $('driveRestore').onclick = showRemote;
  $('exportDownload').onclick = downloadIsoxml;
  $('btnSettings').onclick = openSettings;
  $('fieldBtn').onclick = () => { openSettings(); $('setField').focus(); };
  $('zoomIn').onclick = () => zoom(1.5);
  $('zoomOut').onclick = () => zoom(1 / 1.5);
  $('center').onclick = () => {
    view.follow = true;
    if (last && last.xy) { view.cx = last.xy.x; view.cy = last.xy.y; }
    updateButtons();
    requestDraw();
  };

  // ---------------------------------------------------------------- opstarten
  window.addEventListener('resize', requestDraw);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', requestDraw);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveJob(); syncSoon(); } else keepAwake();
  });
  window.addEventListener('pagehide', () => { saveJob(); });
  setInterval(saveJob, 3000);
  setInterval(() => {
    if (conn && lastDataAt && Date.now() - lastDataAt > 3000) {
      const fix = $('fix');
      fix.textContent = 'Geen signaal';
      fix.dataset.q = 'none';
    }
  }, 1000);

  async function keepAwake() {
    try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) { /* niet ondersteund */ }
  }

  async function init() {
    document.title = brand.name;
    $('brandName').textContent = brand.name;
    await store.init();
    Object.assign(settings, await store.getKV('settings', {}));
    await migrateLegacy();
    const id = await store.getKV('currentJobId', null);
    let j = id ? await store.getJob(id) : null;
    if (!j) {
      j = createJob();
      await store.putJob(j);
    }
    loadJobIntoView(j);
    applyTheme();
    renderAbout();
    updateStatus();
    keepAwake();
    if (!store.durable) toast('Let op: deze browser bewaart geen gegevens. Exporteer elk perceel.');

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    if (sync.configured()) {
      $('sync').hidden = false;
      setSyncStatus('Drive', 'ok');
      sync.start(10 * 60000);  // elke 10 minuten, en meteen bij stoppen, grens klaar of nieuw internet
      setTimeout(() => sync.syncAll(), 4000);
    }

    // Verbinding: via het kastje geopend, of de vorige keuze opnieuw.
    const servedByBox = location.protocol === 'http:' && location.hostname && location.hostname !== 'localhost' &&
      location.hostname !== '127.0.0.1';
    if (settings.connection === 'wifi') settings.connection = 'hotspot';  // oude naam
    if (servedByBox || settings.connection === 'hotspot') connectHotspot();
    else if (settings.connection === 'demo') connectDemo();
    else if (settings.connection === 'ble' && await reconnectBle()) { /* verbinden */ }
    else showWelcome(true);
  }

  // Voor tests
  T.appState = () => ({ settings, job, recordingBoundary, working, last, view, store, sync });
  T.ready = init().catch(e => { console.error(e); toast('Opstarten mislukt: ' + e.message); });
})();
