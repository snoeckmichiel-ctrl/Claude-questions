// isoxml.js - maakt een ISOXML-taak (ISO 11783-10, versie 3) voor een Task Controller.
//
// Resultaat: de map TASKDATA met
//   TASKDATA.XML   klant, bedrijf, perceel met grens en taak
//   TLG00001.XML   beschrijving van het rijspoor (alleen als er een spoor is)
//   TLG00001.BIN   rijspoor: tijd, positie en GPS-kwaliteit per punt
(function (root) {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  function pad(n, w) { return String(n).padStart(w || 2, '0'); }

  // Lokale tijd zonder tijdzone, zoals ISOXML dat verwacht: 2026-10-16T14:05:09
  function isoLocal(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function coord(v) { return v.toFixed(9); }

  // Dagen sinds 1980-01-01 en milliseconden sinds middernacht, in lokale tijd.
  function tlgTime(ms) {
    const d = new Date(ms);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return {
      msOfDay: ms - midnight,
      days: Math.round((dayUtc - Date.UTC(1980, 0, 1)) / 86400000),
    };
  }

  // GGA-kwaliteit naar ISOXML PositionStatus. 0..8 komen overeen.
  function positionStatus(q) {
    return Number.isInteger(q) && q >= 0 && q <= 8 ? q : 15;  // 15 = niet beschikbaar
  }

  // Elk record: tijd (4+2 bytes), noord (4), oost (4), status (1), aantal DLV's (1) = 16 bytes.
  const TLG_RECORD_SIZE = 16;
  const TLG_HEADER_XML =
    '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
    '<TIM A="" D="4">\r\n<PTN A="" B="" D=""/>\r\n</TIM>\r\n';

  function buildTimeLogBin(log) {
    const buf = new ArrayBuffer(log.length * TLG_RECORD_SIZE);
    const v = new DataView(buf);
    log.forEach((p, i) => {
      const o = i * TLG_RECORD_SIZE;
      const t = tlgTime(p.t);
      v.setUint32(o, t.msOfDay, true);
      v.setUint16(o + 4, t.days, true);
      v.setInt32(o + 6, Math.round(p.lat * 1e7), true);
      v.setInt32(o + 10, Math.round(p.lon * 1e7), true);
      v.setUint8(o + 14, positionStatus(p.quality));
      v.setUint8(o + 15, 0);  // geen machinegegevens (DLV)
    });
    return new Uint8Array(buf);
  }

  function ringToXml(points) {
    const ring = points.slice();
    const a = ring[0], b = ring[ring.length - 1];
    if (a.lat !== b.lat || a.lon !== b.lon) ring.push(a);  // veelhoek sluiten
    return ring.map(p => '<PNT A="2" C="' + coord(p.lat) + '" D="' + coord(p.lon) + '"/>').join('\r\n');
  }

  /**
   * opts = {
   *   customer, farm, field, taskName,     teksten (mogen leeg zijn, behalve field)
   *   boundary: [{lat, lon}],              perceelgrens, minstens 3 punten of leeg
   *   areaM2,                              oppervlakte van het perceel
   *   log: [{t, lat, lon, quality}],       rijspoor tijdens het werk, t = ms sinds 1970
   *   software, version
   * }
   * Geeft { "TASKDATA/TASKDATA.XML": string, ... } terug.
   */
  function buildTaskData(opts) {
    const o = Object.assign({ customer: '', farm: '', field: 'Perceel', boundary: [], log: [],
      areaM2: 0, software: 'Trekker-GPS', version: '0.1' }, opts);
    const files = {};
    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<ISO11783_TaskData VersionMajor="3" VersionMinor="3" ManagementSoftwareManufacturer="' +
      esc(o.software) + '" ManagementSoftwareVersion="' + esc(o.version) + '" DataTransferOrigin="1">');

    let ctrRef = '', frmRef = '';
    if (o.customer) {
      lines.push('<CTR A="CTR1" B="' + esc(o.customer) + '"/>');
      ctrRef = 'CTR1';
    }
    if (o.farm) {
      lines.push('<FRM A="FRM1" B="' + esc(o.farm) + '"' + (ctrRef ? ' I="CTR1"' : '') + '/>');
      frmRef = 'FRM1';
    }

    const fieldName = o.field || 'Perceel';
    lines.push('<PFD A="PFD1" C="' + esc(fieldName) + '" D="' + Math.round(o.areaM2 || 0) + '"' +
      (ctrRef ? ' E="CTR1"' : '') + (frmRef ? ' F="FRM1"' : '') + '>');
    if (o.boundary && o.boundary.length >= 3) {
      lines.push('<PLN A="1">', '<LSG A="1">', ringToXml(o.boundary), '</LSG>', '</PLN>');
    }
    lines.push('</PFD>');

    const hasLog = o.log && o.log.length > 0;
    const taskName = o.taskName || fieldName;
    lines.push('<TSK A="TSK1" B="' + esc(taskName) + '"' + (ctrRef ? ' C="CTR1"' : '') +
      (frmRef ? ' D="FRM1"' : '') + ' E="PFD1" G="' + (hasLog ? 4 : 1) + '">');
    if (hasLog) {
      const start = o.log[0].t, stop = o.log[o.log.length - 1].t;
      lines.push('<TIM A="' + isoLocal(start) + '" B="' + isoLocal(stop) + '" D="4"/>');
      lines.push('<TLG A="TLG00001"/>');
      files['TASKDATA/TLG00001.XML'] = TLG_HEADER_XML;
      files['TASKDATA/TLG00001.BIN'] = buildTimeLogBin(o.log);
    }
    lines.push('</TSK>');
    lines.push('</ISO11783_TaskData>');

    files['TASKDATA/TASKDATA.XML'] = lines.join('\r\n') + '\r\n';
    return files;
  }

  const api = { buildTaskData, buildTimeLogBin, tlgTime, isoLocal, esc, TLG_RECORD_SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TG = Object.assign(root.TG || {}, { isoxml: api });
})(this);
