// sync.js - percelen opslaan in Google Drive via een Apps Script in je eigen account.
// Het script staat in drive/Code.gs. Zie de handleiding voor de installatie.
(function (root) {
  'use strict';

  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function safeName(s) {
    return String(s || 'perceel').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'perceel';
  }

  function dateStamp(ms) {
    const d = new Date(ms);
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  class DriveSync {
    /**
     * deps = { store, isoxml, zip, geo, brand, getConfig: () => ({ url, key }), onStatus(text, state) }
     */
    constructor(deps) {
      this.d = deps;
      this.busy = false;
      this.lastError = '';
      this.lastSyncAt = 0;
      this.timer = null;
    }

    configured() {
      const c = this.d.getConfig();
      return !!(c.url && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(c.url));  // http alleen voor tests
    }

    async call(body) {
      const c = this.d.getConfig();
      const res = await fetch(c.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // geen CORS-voorcontrole
        body: JSON.stringify(Object.assign({ key: c.key || '' }, body)),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error('Drive antwoordt met fout ' + res.status);
      let data;
      try { data = await res.json(); } catch (e) { throw new Error('Onverwacht antwoord van Drive'); }
      if (!data.ok) throw new Error(data.error || 'Drive weigert');
      return data;
    }

    ping() { return this.call({ action: 'ping' }); }

    buildPayload(job) {
      const { isoxml, zip, geo, brand } = this.d;
      const areaM2 = job.boundary && job.boundary.length >= 3 ? geo.areaLatLon(job.boundary) : 0;
      const files = isoxml.buildTaskData({
        customer: job.customer, farm: job.farm, field: job.name, boundary: job.boundary,
        areaM2, log: job.log, software: brand.name, version: brand.version,
      });
      const zipBytes = zip.makeZip(files);
      return {
        action: 'save',
        job,
        summary: {
          id: job.id, name: job.name, customer: job.customer, farm: job.farm, createdAt: job.createdAt,
          updatedAt: job.updatedAt, areaM2, workedM2: job.workedM2, workWidth: job.workWidth,
        },
        zipName: 'TASKDATA_' + safeName(job.name) + '_' + dateStamp(job.createdAt) + '_' + job.id + '.zip',
        zipBase64: toBase64(zipBytes),
      };
    }

    // Stuurt alle percelen die nieuwer zijn dan hun laatste kopie in Drive.
    async syncAll() {
      if (!this.configured() || this.busy) return { sent: 0, pending: await this.pendingCount() };
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        this.status('Wacht op internet', 'off');
        return { sent: 0, pending: await this.pendingCount() };
      }
      this.busy = true;
      let sent = 0;
      try {
        const list = await this.d.store.listJobs();
        const todo = list.filter(s => !s.syncedAt || s.updatedAt > s.syncedAt);
        if (todo.length) this.status('Opslaan in Drive…', 'busy');
        for (const s of todo) {
          const job = await this.d.store.getJob(s.id);
          if (!job) continue;
          const version = job.updatedAt;
          await this.call(this.buildPayload(job));
          await this.d.store.markSynced(job.id, version);
          sent++;
        }
        this.lastError = '';
        this.lastSyncAt = Date.now();
        this.status('Opgeslagen in Drive', 'ok');
      } catch (e) {
        this.lastError = e && e.message ? e.message : String(e);
        this.status('Drive: ' + this.lastError, 'bad');
      } finally {
        this.busy = false;
      }
      return { sent, pending: await this.pendingCount() };
    }

    async pendingCount() {
      const list = await this.d.store.listJobs();
      return list.filter(s => !s.syncedAt || s.updatedAt > s.syncedAt).length;
    }

    // Percelen in Drive die nog niet op deze tablet staan.
    async listRemote() {
      const data = await this.call({ action: 'list' });
      const local = new Set((await this.d.store.listJobs()).map(s => s.id));
      return (data.jobs || []).filter(j => !local.has(j.id));
    }

    async restore(id) {
      const data = await this.call({ action: 'get', id });
      if (!data.job || data.job.id !== id) throw new Error('Perceel niet gevonden in Drive');
      await this.d.store.putJob(data.job, data.job.updatedAt);
      return data.job;
    }

    status(text, state) { if (this.d.onStatus) this.d.onStatus(text, state); }

    // Probeert regelmatig, en meteen zodra er weer internet is.
    start(intervalMs) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.syncAll(), intervalMs || 60000);
      if (typeof window !== 'undefined') window.addEventListener('online', () => this.syncAll());
    }
  }

  const api = { DriveSync, toBase64, safeName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TG = Object.assign(root.TG || {}, { sync: api });
})(this);
