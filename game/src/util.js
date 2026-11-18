// util.js — shared helpers for Palmera Nights: math, a seeded random, circle-vs-AABB
// collision against the city's building boxes, and canvas-texture makers. Everything the
// game draws is generated here or in city.js; there are no image files and no network use.
'use strict';
var NV = window.NV || (window.NV = {});

NV.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
NV.lerp = function (a, b, t) { return a + (b - a) * t; };

// Shortest-arc angle helpers. Headings are radians, 0 faces +Z, positive turns toward +X.
NV.wrapAngle = function (a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
NV.angleLerp = function (a, b, t) {
  return a + NV.wrapAngle(b - a) * NV.clamp(t, 0, 1);
};
NV.dist2 = function (ax, az, bx, bz) {
  var dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
};

// mulberry32: small deterministic RNG so the city layout is the same on every load.
NV.makeRng = function (seed) {
  var s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
NV.randRange = function (rng, a, b) { return a + rng() * (b - a); };
NV.randPick = function (rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; };

// Push a circle (pos.x / pos.z, radius r) out of every AABB in boxes. Mutates pos and
// returns true when a push happened, so callers can play a thud or kill speed.
NV.resolveCircle = function (pos, r, boxes) {
  var hit = false;
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i];
    var cx = NV.clamp(pos.x, b.minX, b.maxX);
    var cz = NV.clamp(pos.z, b.minZ, b.maxZ);
    var dx = pos.x - cx, dz = pos.z - cz;
    var d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      hit = true;
      if (d2 > 1e-6) {
        var d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * r;
        pos.z = cz + (dz / d) * r;
      } else {
        // Centre is inside the box: push out along the smallest penetration axis.
        var pl = pos.x - b.minX, pr = b.maxX - pos.x, pt = pos.z - b.minZ, pb = b.maxZ - pos.z;
        var m = Math.min(pl, pr, pt, pb);
        if (m === pl) pos.x = b.minX - r;
        else if (m === pr) pos.x = b.maxX + r;
        else if (m === pt) pos.z = b.minZ - r;
        else pos.z = b.maxZ + r;
      }
    }
  }
  return hit;
};

// Canvas helpers: every texture in the game is painted on a canvas at boot.
NV.makeCanvas = function (w, h, draw) {
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return c;
};
NV.canvasTexture = function (canvas, srgb) {
  var t = new THREE.CanvasTexture(canvas);
  if (srgb !== false) t.encoding = THREE.sRGBEncoding;
  t.anisotropy = 4;
  return t;
};
