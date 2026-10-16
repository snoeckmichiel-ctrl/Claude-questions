// nmea.js - NMEA 0183 lezen: GGA, VTG, RMC en ZDA.
(function (root) {
  'use strict';

  function checksumOk(line) {
    if (!line || line[0] !== '$') return false;
    const star = line.lastIndexOf('*');
    if (star < 0 || star + 3 !== line.length) return false;
    let cs = 0;
    for (let i = 1; i < star; i++) cs ^= line.charCodeAt(i);
    return cs === parseInt(line.slice(star + 1), 16);
  }

  function withChecksum(body) {
    let cs = 0;
    for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
    return '$' + body + '*' + cs.toString(16).toUpperCase().padStart(2, '0');
  }

  // "5106.1234" + "N" -> graden als kommagetal
  function parseLatLon(value, hemi) {
    if (!value) return null;
    const dot = value.indexOf('.');
    const degLen = (dot < 0 ? value.length : dot) - 2;
    if (degLen < 1) return null;
    const deg = parseInt(value.slice(0, degLen), 10);
    const min = parseFloat(value.slice(degLen));
    if (isNaN(deg) || isNaN(min)) return null;
    const d = deg + min / 60;
    return hemi === 'S' || hemi === 'W' ? -d : d;
  }

  // "123519.50" -> milliseconden sinds middernacht UTC
  function parseTime(value) {
    if (!value || value.length < 6) return null;
    const h = +value.slice(0, 2), m = +value.slice(2, 4), s = parseFloat(value.slice(4));
    if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
    return Math.round(((h * 60 + m) * 60 + s) * 1000);
  }

  function num(v) {
    if (v === undefined || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  function parseSentence(line) {
    if (!checksumOk(line)) return null;
    const f = line.slice(1, line.lastIndexOf('*')).split(',');
    const type = f[0].slice(2);
    switch (type) {
      case 'GGA':
        return {
          type, timeUtc: parseTime(f[1]),
          lat: parseLatLon(f[2], f[3]), lon: parseLatLon(f[4], f[5]),
          quality: f[6] === '' ? 0 : parseInt(f[6], 10),
          sats: num(f[7]), hdop: num(f[8]), alt: num(f[9]),
        };
      case 'VTG':
        return { type, course: num(f[1]), speedKmh: num(f[7]) };
      case 'RMC': {
        const knots = num(f[7]);
        const d = f[9];
        return {
          type, timeUtc: parseTime(f[1]), valid: f[2] === 'A',
          lat: parseLatLon(f[3], f[4]), lon: parseLatLon(f[5], f[6]),
          speedKmh: knots === null ? null : knots * 1.852, course: num(f[8]),
          date: d && d.length === 6 ? '20' + d.slice(4, 6) + '-' + d.slice(2, 4) + '-' + d.slice(0, 2) : null,
        };
      }
      case 'ZDA':
        return {
          type, timeUtc: parseTime(f[1]),
          date: f[4] && f[3] && f[2] ? f[4] + '-' + f[3].padStart(2, '0') + '-' + f[2].padStart(2, '0') : null,
        };
      default:
        return { type };
    }
  }

  // Houdt de laatste toestand bij. onPosition wordt opgeroepen bij elke GGA met fix.
  class NmeaParser {
    constructor(onPosition) {
      this.onPosition = onPosition || function () {};
      this.buffer = '';
      this.badLines = 0;
      this.state = {
        lat: null, lon: null, alt: null, quality: 0, sats: null, hdop: null,
        speedKmh: null, course: null, timeUtc: null, date: null,
      };
    }

    feed(text) {
      this.buffer += text;
      let nl;
      while ((nl = this.buffer.search(/[\r\n]/)) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.handleLine(line);
      }
      if (this.buffer.length > 512) this.buffer = '';  // rommel zonder regeleinde
    }

    handleLine(line) {
      const start = line.indexOf('$');
      if (start < 0) return;
      const s = parseSentence(line.slice(start));
      if (!s) { this.badLines++; return; }
      const st = this.state;
      if (s.type === 'GGA') {
        st.quality = s.quality;
        st.sats = s.sats;
        st.hdop = s.hdop;
        if (s.timeUtc !== null) st.timeUtc = s.timeUtc;
        if (s.quality > 0 && s.lat !== null && s.lon !== null) {
          st.lat = s.lat; st.lon = s.lon; st.alt = s.alt;
          this.onPosition(Object.assign({}, st));
        }
      } else if (s.type === 'VTG') {
        if (s.speedKmh !== null) st.speedKmh = s.speedKmh;
        if (s.course !== null) st.course = s.course;
      } else if (s.type === 'RMC') {
        if (s.date) st.date = s.date;
        if (s.speedKmh !== null) st.speedKmh = s.speedKmh;
        if (s.course !== null) st.course = s.course;
      } else if (s.type === 'ZDA') {
        if (s.date) st.date = s.date;
      }
    }
  }

  const QUALITY_NAMES = ['Geen fix', 'GPS', 'DGPS', 'PPS', 'RTK fix', 'RTK float', 'Geschat', 'Manueel', 'Simulatie'];

  const api = { checksumOk, withChecksum, parseLatLon, parseTime, parseSentence, NmeaParser, QUALITY_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TG = Object.assign(root.TG || {}, { nmea: api });
})(this);
