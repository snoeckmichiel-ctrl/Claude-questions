// Test van drive/Code.gs met een nagebootste Google-omgeving:  node --test test/drive_script.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeGoogle() {
  let nextId = 1;
  const files = [];
  const folders = [];
  const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };

  function makeFile(name, bytes, parent) {
    const f = { id: 'f' + nextId++, name, bytes, parent, trashed: false };
    f.getUrl = () => 'https://drive/' + f.id;
    f.setTrashed = t => { f.trashed = t; };
    f.getBlob = () => ({ getDataAsString: () => Buffer.from(f.bytes).toString('utf8') });
    f.moveTo = folder => { f.parent = folder; };
    f.getId = () => f.id;
    files.push(f);
    return f;
  }
  function makeFolder(name, parent) {
    const d = { id: 'd' + nextId++, name, parent };
    d.getUrl = () => 'https://drive/' + d.id;
    d.getFoldersByName = n => iter(folders.filter(x => x.parent === d && x.name === n));
    d.createFolder = n => makeFolder(n, d);
    d.getFilesByName = n => iter(files.filter(f => f.parent === d && f.name === n && !f.trashed));
    d.searchFiles = q => {
      const m = /title contains "([^"]+)"/.exec(q);
      return iter(files.filter(f => f.parent === d && !f.trashed && f.name.includes(m[1])));
    };
    d.createFile = blob => makeFile(blob.name, blob.bytes, d);
    folders.push(d);
    return d;
  }
  const root = { name: 'Mijn Drive' };
  const sheets = new Map();
  const props = new Map();

  const google = {
    DriveApp: {
      getFoldersByName: n => iter(folders.filter(x => x.parent === root && x.name === n)),
      createFolder: n => makeFolder(n, root),
      getFileById: id => files.find(f => f.id === id),
    },
    Utilities: {
      newBlob: (data, mime, name) => ({ bytes: Buffer.from(data), mime, name }),
      base64Decode: s => Buffer.from(s, 'base64'),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: text => ({ text, setMimeType() { return this; } }),
    },
    HtmlService: { createHtmlOutput: h => h },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }),
    },
    SpreadsheetApp: {
      create: name => {
        const file = makeFile(name, Buffer.alloc(0), root);
        const rows = [];
        const sheet = {
          appendRow: r => rows.push(r.slice()),
          setFrozenRows() {},
          getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }),
          getRange: (r, c, nr, nc) => ({ setValues: v => { rows[r - 1] = v[0].slice(); } }),
          rows,
        };
        sheets.set(file.id, sheet);
        return { getId: () => file.id, getSheets: () => [sheet] };
      },
      openById: id => {
        if (!sheets.has(id)) throw new Error('niet gevonden');
        return { getSheets: () => [sheets.get(id)] };
      },
    },
  };
  return { google, files, folders, sheets };
}

function load() {
  const env = fakeGoogle();
  const ctx = vm.createContext(Object.assign({ JSON, Date, Math, String, Number, Error }, env.google));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'drive', 'Code.gs'), 'utf8'), ctx);
  const KEY = vm.runInContext('SLEUTEL', ctx);
  const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ key: KEY }, body)) } }).text);
  return { env, post, ctx };
}

const job = {
  id: 'mn3k8x2a1bc9de', name: 'Achter de schuur', customer: 'Snoeck', farm: '', workWidth: 12,
  createdAt: Date.UTC(2026, 9, 16, 8), updatedAt: Date.UTC(2026, 9, 16, 10), boundary: [], runs: [], log: [], workedM2: 4800,
};
const summary = { id: job.id, name: job.name, customer: 'Snoeck', farm: '', createdAt: job.createdAt,
  updatedAt: job.updatedAt, areaM2: 24000, workedM2: 4800, workWidth: 12 };

test('Drive-script: sleutel wordt gecontroleerd', () => {
  const { post } = load();
  assert.strictEqual(post({ key: 'fout', action: 'ping' }).ok, false);
  assert.strictEqual(post({ action: 'ping' }).ok, true);
});

test('Drive-script: bewaren, overzicht, lijst en terughalen', () => {
  const { env, post } = load();
  const zip = Buffer.from('PK-test').toString('base64');
  const r1 = post({ action: 'save', job, summary, zipName: 'TASKDATA_Achter_de_schuur_' + job.id + '.zip', zipBase64: zip });
  assert.deepStrictEqual(r1, { ok: true });

  // Tweede keer: zelfde perceel, gewijzigde naam. Geen dubbele bestanden.
  const job2 = Object.assign({}, job, { name: 'Weide', updatedAt: job.updatedAt + 60000, workedM2: 9600 });
  const sum2 = Object.assign({}, summary, { name: 'Weide', updatedAt: job2.updatedAt, workedM2: 9600 });
  post({ action: 'save', job: job2, summary: sum2, zipName: 'TASKDATA_Weide_' + job.id + '.zip', zipBase64: zip });

  const live = env.files.filter(f => !f.trashed && f.parent && f.parent.name);
  const zips = live.filter(f => f.parent.name === 'ISOXML');
  const backups = live.filter(f => f.parent.name === '_gegevens');
  assert.deepStrictEqual(zips.map(f => f.name), ['TASKDATA_Weide_' + job.id + '.zip']);
  assert.deepStrictEqual(backups.map(f => f.name), [job.id + '.json']);
  assert.strictEqual(Buffer.from(zips[0].bytes).toString(), 'PK-test');

  const sheet = [...env.sheets.values()][0];
  assert.strictEqual(sheet.rows.length, 2, 'kopregel en één perceel');
  assert.strictEqual(sheet.rows[1][1], 'Weide');
  assert.strictEqual(sheet.rows[1][5], 0.96);

  const list = post({ action: 'list' });
  assert.strictEqual(list.jobs.length, 1);
  assert.strictEqual(list.jobs[0].id, job.id);
  assert.strictEqual(list.jobs[0].updatedAt, job2.updatedAt);

  const got = post({ action: 'get', id: job.id });
  assert.strictEqual(got.job.name, 'Weide');
  assert.strictEqual(post({ action: 'get', id: '../../x' }).ok, false);
});
