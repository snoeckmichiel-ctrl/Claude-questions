// geo.js - omrekenen tussen GPS-coördinaten en meters op het perceel.
(function (root) {
  'use strict';
  const R = 6378137;  // straal van de aarde (WGS84), in meter
  const RAD = Math.PI / 180;

  // Vlak assenstelsel rond een vast punt. Nauwkeurig genoeg binnen enkele km.
  class LocalFrame {
    constructor(lat0, lon0) {
      this.lat0 = lat0;
      this.lon0 = lon0;
      this.kx = R * RAD * Math.cos(lat0 * RAD);
      this.ky = R * RAD;
    }
    toXY(lat, lon) { return { x: (lon - this.lon0) * this.kx, y: (lat - this.lat0) * this.ky }; }
    toLatLon(x, y) { return { lat: this.lat0 + y / this.ky, lon: this.lon0 + x / this.kx }; }
  }

  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Oppervlakte van een veelhoek in m² (formule van Gauss).
  function polygonArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      s += p.x * q.y - q.x * p.y;
    }
    return Math.abs(s) / 2;
  }

  // Oppervlakte rechtstreeks uit GPS-punten [{lat, lon}].
  function areaLatLon(points) {
    if (points.length < 3) return 0;
    const f = new LocalFrame(points[0].lat, points[0].lon);
    return polygonArea(points.map(p => f.toXY(p.lat, p.lon)));
  }

  const api = { LocalFrame, distance, polygonArea, areaLatLon };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TG = Object.assign(root.TG || {}, { geo: api });
})(this);
