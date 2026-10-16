// zip.js - eenvoudige ZIP-maker zonder compressie, werkt zonder internet.
(function (root) {
  'use strict';

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    return new TextEncoder().encode(String(data));
  }

  // files: { "map/naam.ext": string | Uint8Array }  ->  Uint8Array met het ZIP-bestand
  function makeZip(files, date) {
    const d = date || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const locals = [], centrals = [];
    let offset = 0;

    for (const name of Object.keys(files)) {
      const nameBytes = new TextEncoder().encode(name);
      const data = toBytes(files[name]);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);       // versie nodig om uit te pakken
      local.setUint16(6, 0x0800, true);   // UTF-8-namen
      local.setUint16(8, 0, true);        // geen compressie
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      locals.push(new Uint8Array(local.buffer), nameBytes, data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, dosTime, true);
      central.setUint16(14, dosDate, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, nameBytes.length, true);
      central.setUint32(42, offset, true);
      centrals.push(new Uint8Array(central.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = centrals.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Object.keys(files).length, true);
    end.setUint16(10, Object.keys(files).length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    const parts = locals.concat(centrals, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(parts.reduce((s, a) => s + a.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }

  const api = { crc32, makeZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TG = Object.assign(root.TG || {}, { zip: api });
})(this);
