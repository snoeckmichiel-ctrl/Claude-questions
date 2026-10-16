// demo.js - simuleert een tractor die een perceel heen en weer afrijdt.
// Maakt echte NMEA-zinnen, zodat de hele app getest wordt zoals met een GPS.
(function (root) {
  'use strict';
  const geo = root.TG ? root.TG.geo : require('./geo.js');
  const nmea = root.TG ? root.TG.nmea : require('./nmea.js');

  function fmtLat(lat) {
    const a = Math.abs(lat), d = Math.floor(a), m = (a - d) * 60;
    return String(d).padStart(2, '0') + m.toFixed(7).padStart(10, '0') + ',' + (lat >= 0 ? 'N' : 'S');
  }
  function fmtLon(lon) {
    const a = Math.abs(lon), d = Math.floor(a), m = (a - d) * 60;
    return String(d).padStart(3, '0') + m.toFixed(7).padStart(10, '0') + ',' + (lon >= 0 ? 'E' : 'W');
  }
  function fmtTime(date) {
    const p = n => String(n).padStart(2, '0');
    return p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + '.' +
      String(Math.floor(date.getUTCMilliseconds() / 10)).padStart(2, '0');
  }

  // Route: eerst rond het perceel, dan banen van 'width' meter breed.
  function buildRoute(lengthM, widthM, workWidth) {
    const pts = [{ x: 0, y: 0 }, { x: lengthM, y: 0 }, { x: lengthM, y: widthM }, { x: 0, y: widthM }, { x: 0, y: 0 }];
    let y = workWidth / 2, dir = 1;
    while (y < widthM) {
      const x0 = dir > 0 ? 0 : lengthM, x1 = dir > 0 ? lengthM : 0;
      pts.push({ x: x0, y }, { x: x1, y });
      y += workWidth;
      dir = -dir;
    }
    return pts;
  }

  class DemoTractor {
    constructor(onText, options) {
      const o = Object.assign({ lat: 51.0543, lon: 3.7174, length: 200, width: 120,
        workWidth: 12, speedKmh: 12, hz: 5, quality: 4 }, options);
      this.o = o;
      this.onText = onText;
      this.frame = new geo.LocalFrame(o.lat, o.lon);
      this.route = buildRoute(o.length, o.width, o.workWidth);
      this.seg = 0;
      this.pos = Object.assign({}, this.route[0]);
      this.timer = null;
    }

    start() {
      if (this.timer) return;
      this.timer = setInterval(() => this.step(1 / this.o.hz), 1000 / this.o.hz);
    }

    stop() { clearInterval(this.timer); this.timer = null; }

    // Eén meting verder rijden en de NMEA-zinnen uitsturen.
    step(dt) {
      let move = (this.o.speedKmh / 3.6) * dt;
      let heading = 0;
      while (move > 0) {
        const target = this.route[(this.seg + 1) % this.route.length];
        const dx = target.x - this.pos.x, dy = target.y - this.pos.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-9) heading = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        if (dist <= move) {
          this.pos = Object.assign({}, target);
          move -= dist;
          this.seg = (this.seg + 1) % this.route.length;
        } else {
          this.pos.x += dx / dist * move;
          this.pos.y += dy / dist * move;
          move = 0;
        }
      }
      this.heading = heading;
      const ll = this.frame.toLatLon(this.pos.x, this.pos.y);
      const now = new Date();
      const t = fmtTime(now);
      const knots = this.o.speedKmh / 1.852;
      const p = n => String(n).padStart(2, '0');
      const date = p(now.getUTCDate()) + p(now.getUTCMonth() + 1) + p(now.getUTCFullYear() % 100);
      const lines = [
        nmea.withChecksum('GNRMC,' + t + ',A,' + fmtLat(ll.lat) + ',' + fmtLon(ll.lon) + ',' +
          knots.toFixed(2) + ',' + heading.toFixed(1) + ',' + date + ',,,R,V'),
        nmea.withChecksum('GNGGA,' + t + ',' + fmtLat(ll.lat) + ',' + fmtLon(ll.lon) + ',' +
          this.o.quality + ',22,0.6,15.0,M,46.0,M,1.0,0000'),
        nmea.withChecksum('GNVTG,' + heading.toFixed(1) + ',T,,M,' + knots.toFixed(2) + ',N,' +
          this.o.speedKmh.toFixed(2) + ',K,R'),
      ];
      this.onText(lines.join('\r\n') + '\r\n');
      return ll;
    }
  }

  const api = { DemoTractor, buildRoute, fmtLat, fmtLon };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TG = Object.assign(root.TG || {}, { demo: api });
})(this);
