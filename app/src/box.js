// box.js - het GPS-kastje vinden in de hotspot van de tablet en de GPS-stroom lezen.
//
// Android kiest bij elke start van de hotspot een ander adresbereik. Het kastje neemt
// daarin altijd het adres dat op .200 eindigt. De app zoekt in deze volgorde:
//   1. het adres dat je zelf invulde
//   2. het adres van de pagina, als de app via het kastje geopend werd
//   3. het laatst gekende adres
//   4. het adres dat het kastje meldde aan je Drive-koppeling
//   5. alle adressen 192.168.0.200 tot 192.168.255.200
(function (root) {
  'use strict';

  const HOST_OCTET = 200;

  // Leest Server-Sent Events uit een tekstbuffer. Geeft de volledige berichten en de rest terug.
  function parseSse(buffer) {
    const events = [];
    const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
    const rest = parts.pop();
    for (const part of parts) {
      let event = 'message';
      const data = [];
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) events.push({ event, data: data.join('\n') });
    }
    return { events, rest };
  }

  function scanCandidates(octet) {
    const list = [];
    for (let i = 0; i < 256; i++) list.push('192.168.' + i + '.' + (octet || HOST_OCTET));
    return list;
  }

  // Online app (https) naar een privé-adres: Chrome laat dat toe als lokaal netwerk.
  // Alleen dan aankondigen, anders blokkeert Chrome een verzoek dat niet overeenkomt.
  function fetchOptions(host, extra) {
    const o = Object.assign({ cache: 'no-store' }, extra);
    const ip = String(host).split(':')[0];
    const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
    if (typeof location !== 'undefined' && location.protocol === 'https:' && isPrivate) o.targetAddressSpace = 'local';
    return o;
  }

  function uniq(list) {
    const seen = new Set();
    return list.filter(x => x && !seen.has(x) && seen.add(x));
  }

  class BoxLink {
    /**
     * opts = {
     *   onText(text)            NMEA-tekst
     *   onState(state, detail)  'searching' | 'connecting' | 'ok' | 'lost' | 'notfound'
     *   whereis()               belofte met het adres uit Drive, of null
     * }
     */
    constructor(opts) {
      this.o = opts;
      this.closed = false;
      this.host = '';
      this.abort = null;
      this.retry = null;
    }

    async probe(host, timeoutMs) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs || 2500);
      try {
        const res = await fetch('http://' + host + '/api/info', fetchOptions(host, { signal: ctrl.signal }));
        if (!res.ok) return null;
        const info = await res.json();
        return info && info.name === 'Trekker-GPS' ? info : null;
      } catch (e) {
        return null;
      } finally {
        clearTimeout(t);
      }
    }

    async discover(known) {
      const quick = uniq(known);
      for (const h of quick) {
        if (this.closed) return null;
        this.state('searching', 'Proberen: ' + h);
        if (await this.probe(h)) return h;
      }
      if (this.o.whereis) {
        this.state('searching', 'Adres opvragen bij Google Drive');
        try {
          const ip = await this.o.whereis();
          if (ip && !quick.includes(ip) && await this.probe(ip)) return ip;
        } catch (e) { /* geen internet of Drive niet ingesteld */ }
      }
      const all = scanCandidates();
      const batch = 32;
      for (let i = 0; i < all.length && !this.closed; i += batch) {
        this.state('searching', 'Zoeken in de hotspot: ' + Math.min(100, Math.round(i / all.length * 100)) + '%');
        const slice = all.slice(i, i + batch);
        const found = await new Promise(resolve => {
          let left = slice.length;
          slice.forEach(h => this.probe(h, 1500).then(info => {
            if (info) resolve(h);
            else if (--left === 0) resolve(null);
          }));
        });
        if (found) return found;
      }
      return null;
    }

    // Zoekt het kastje en blijft verbonden. Bij verlies opnieuw zoeken.
    async start(known) {
      this.closed = false;
      const host = await this.discover(known);
      if (this.closed) return;
      if (!host) {
        this.state('notfound', 'Kastje niet gevonden');
        this.retry = setTimeout(() => this.start(known), 10000);
        return;
      }
      this.host = host;
      this.stream(host, known);
    }

    async stream(host, known) {
      let failures = 0;
      while (!this.closed) {
        this.state('connecting', host);
        this.abort = new AbortController();
        try {
          const res = await fetch('http://' + host + '/events', fetchOptions(host, {
            signal: this.abort.signal, headers: { Accept: 'text/event-stream' },
          }));
          if (!res.ok || !res.body) throw new Error('status ' + res.status);
          this.state('ok', host);
          failures = 0;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const r = parseSse(buf);
            buf = r.rest;
            for (const ev of r.events) if (ev.event === 'nmea') this.o.onText(ev.data + '\n');
            if (buf.length > 65536) buf = '';
          }
        } catch (e) { /* verbinding weg */ }
        if (this.closed) return;
        failures++;
        this.state('lost', host);
        if (failures >= 4) {
          // Waarschijnlijk een nieuw hotspotbereik: opnieuw zoeken.
          this.start([host].concat(known || []));
          return;
        }
        await new Promise(r => { this.retry = setTimeout(r, 2000); });
      }
    }

    state(s, detail) { if (this.o.onState) this.o.onState(s, detail); }

    close() {
      this.closed = true;
      clearTimeout(this.retry);
      if (this.abort) this.abort.abort();
    }
  }

  const api = { BoxLink, parseSse, scanCandidates, fetchOptions, HOST_OCTET };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TG = Object.assign(root.TG || {}, { box: api });
})(this);
