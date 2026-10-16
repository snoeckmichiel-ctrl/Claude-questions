// store.js - bewaart percelen op de tablet in IndexedDB.
//
// Twee tabellen:
//   jobs   het volledige perceel: grens, stroken, rijspoor
//   index  korte samenvatting per perceel voor de lijst, plus syncedAt voor Drive
(function (root) {
  'use strict';
  const DB_NAME = 'trekkergps';
  const DB_VERSION = 1;

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transactie afgebroken'));
    });
  }

  function areaOf(job, geo) {
    return geo && job.boundary && job.boundary.length >= 3 ? geo.areaLatLon(job.boundary) : 0;
  }

  function summarize(job, geo, syncedAt) {
    return {
      id: job.id, name: job.name, customer: job.customer || '', farm: job.farm || '',
      createdAt: job.createdAt, updatedAt: job.updatedAt, workWidth: job.workWidth,
      areaM2: areaOf(job, geo), workedM2: job.workedM2 || 0, logPoints: (job.log || []).length,
      syncedAt: syncedAt || 0,
    };
  }

  class Store {
    constructor(geo) {
      this.geo = geo;
      this.db = null;
      this.memory = null;  // noodoplossing als IndexedDB niet werkt
      this.persisted = false;
    }

    async init() {
      try {
        this.db = await new Promise((resolve, reject) => {
          const r = indexedDB.open(DB_NAME, DB_VERSION);
          r.onupgradeneeded = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('index')) db.createObjectStore('index', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
          };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          r.onblocked = () => reject(new Error('databank geblokkeerd'));
        });
      } catch (e) {
        this.memory = { jobs: new Map(), index: new Map(), kv: new Map() };
        return false;
      }
      try {
        if (navigator.storage && navigator.storage.persist) this.persisted = await navigator.storage.persist();
      } catch (e) { /* niet beschikbaar zonder https */ }
      return true;
    }

    get durable() { return !!this.db; }

    async getJob(id) {
      if (this.memory) return this.memory.jobs.get(id) || null;
      return (await req(this.db.transaction('jobs').objectStore('jobs').get(id))) || null;
    }

    // Bewaart het perceel. syncedAt blijft behouden tenzij het meegegeven wordt.
    async putJob(job, syncedAt) {
      if (this.memory) {
        const prev = this.memory.index.get(job.id);
        this.memory.jobs.set(job.id, JSON.parse(JSON.stringify(job)));
        this.memory.index.set(job.id, summarize(job, this.geo, syncedAt ?? (prev ? prev.syncedAt : 0)));
        return;
      }
      const tx = this.db.transaction(['jobs', 'index'], 'readwrite');
      const index = tx.objectStore('index');
      const prev = await req(index.get(job.id));
      tx.objectStore('jobs').put(job);
      index.put(summarize(job, this.geo, syncedAt ?? (prev ? prev.syncedAt : 0)));
      await done(tx);
    }

    async deleteJob(id) {
      if (this.memory) { this.memory.jobs.delete(id); this.memory.index.delete(id); return; }
      const tx = this.db.transaction(['jobs', 'index'], 'readwrite');
      tx.objectStore('jobs').delete(id);
      tx.objectStore('index').delete(id);
      await done(tx);
    }

    // Alle samenvattingen, nieuwste eerst.
    async listJobs() {
      const all = this.memory ? [...this.memory.index.values()]
        : await req(this.db.transaction('index').objectStore('index').getAll());
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    // Markeert als opgeslagen in Drive, maar alleen de versie die echt verstuurd werd.
    async markSynced(id, updatedAt) {
      if (this.memory) {
        const s = this.memory.index.get(id);
        if (s) s.syncedAt = Math.max(s.syncedAt || 0, updatedAt);
        return;
      }
      const tx = this.db.transaction('index', 'readwrite');
      const index = tx.objectStore('index');
      const s = await req(index.get(id));
      if (s) { s.syncedAt = Math.max(s.syncedAt || 0, updatedAt); index.put(s); }
      await done(tx);
    }

    async getKV(key, fallback) {
      if (this.memory) return this.memory.kv.has(key) ? this.memory.kv.get(key) : fallback;
      const v = await req(this.db.transaction('kv').objectStore('kv').get(key));
      return v === undefined ? fallback : v;
    }

    async setKV(key, value) {
      if (this.memory) { this.memory.kv.set(key, value); return; }
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      await done(tx);
    }
  }

  function createJob(defaults) {
    const now = Date.now();
    return Object.assign({
      id: newId(), name: 'Perceel', customer: '', farm: '', workWidth: 12,
      createdAt: now, updatedAt: now, origin: null, boundary: [], runs: [], log: [], workedM2: 0,
    }, defaults || {});
  }

  const api = { Store, createJob, newId, summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TG = Object.assign(root.TG || {}, { store: api });
})(this);
