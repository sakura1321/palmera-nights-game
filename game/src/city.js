// city.js — builds Palmera: a 5x5-block coastal city on a road grid. The whole ground
// (asphalt, lane dashes, sidewalks, crosswalks) is painted onto one big canvas texture;
// buildings are low-poly boxes with canvas-painted window facades. Every building, crate
// and barrier registers an AABB in world.colliders for the shared collision solver.
'use strict';

// Layout constants. Roads run along both axes at roadCenters; blocks sit between them.
NV.CITY = {
  BLOCK: 56,
  ROAD: 18,
  PITCH: 74,               // BLOCK + ROAD
  GRID: 5,                 // blocks per side
  SPAN: 5 * 74 + 18,       // 388 world units across
  HALF: (5 * 74 + 18) / 2  // 194
};
NV.CITY.roadCenters = [];
for (var rc = 0; rc <= NV.CITY.GRID; rc++) {
  NV.CITY.roadCenters.push(-NV.CITY.HALF + NV.CITY.ROAD / 2 + rc * NV.CITY.PITCH);
}
// World position of the south-west corner of block (i, j).
NV.blockOrigin = function (i, j) {
  return {
    x: -NV.CITY.HALF + NV.CITY.ROAD + i * NV.CITY.PITCH,
    z: -NV.CITY.HALF + NV.CITY.ROAD + j * NV.CITY.PITCH
  };
};

// Facade texture: a light, tintable wall with a grid of windows, some of them lit.
// Painted at 256x512 so windows stay crisp when the player walks right up to a wall.
function facadeTexture(rng, litRatio) {
  return NV.canvasTexture(NV.makeCanvas(256, 512, function (g, w, h) {
    g.fillStyle = '#d8d5cc';
    g.fillRect(0, 0, w, h);
    var cols = 8, rows = 16, ww = w / cols, wh = h / rows;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var lit = rng() < litRatio;
        g.fillStyle = lit ? '#ffca7a' : '#33475c';
        g.fillRect(x * ww + 4, y * wh + 5, ww - 8, wh - 10);
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.fillRect(x * ww + 4, y * wh + 5, ww - 8, 4);
      }
    }
  }));
}

function woodTexture() {
  return NV.canvasTexture(NV.makeCanvas(64, 64, function (g, w, h) {
    g.fillStyle = '#9a6b3f';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#6e4a28';
    g.lineWidth = 3;
    g.strokeRect(2, 2, w - 4, h - 4);
    g.beginPath(); g.moveTo(2, 2); g.lineTo(w - 2, h - 2);
    g.moveTo(w - 2, 2); g.lineTo(2, h - 2); g.stroke();
  }));
}

function stripesTexture() {
  return NV.canvasTexture(NV.makeCanvas(64, 32, function (g, w, h) {
    g.fillStyle = '#e8e4da';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#e06426';
    for (var x = -1; x < 4; x++) {
      g.beginPath();
      g.moveTo(x * 24, h); g.lineTo(x * 24 + 12, 0); g.lineTo(x * 24 + 24, 0); g.lineTo(x * 24 + 12, h);
      g.fill();
    }
  }));
}

// The garage's front: roller door plus the business sign, painted on one canvas.
function garageFrontTexture() {
  return NV.canvasTexture(NV.makeCanvas(512, 192, function (g, w, h) {
    g.fillStyle = '#c9bfa8';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#274b63';
    g.fillRect(0, 0, w, 64);
    g.fillStyle = '#ffd94d';
    g.font = 'bold 40px Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('DELGADO AUTO WORKS', w / 2, 45);
    g.fillStyle = '#7d8894';
    g.fillRect(96, 84, 320, 108);
    g.strokeStyle = '#4c565f';
    g.lineWidth = 3;
    for (var i = 0; i < 5; i++) {
      g.beginPath(); g.moveTo(96, 84 + i * 27); g.lineTo(416, 84 + i * 27); g.stroke();
    }
    g.strokeRect(96, 84, 320, 108);
  }));
}

function signTexture(text, bg, fg) {
  return NV.canvasTexture(NV.makeCanvas(256, 64, function (g, w, h) {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.font = 'bold 30px Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText(text, w / 2, 42);
  }));
}

// Paint the entire ground plane: sand base, block pavement, sidewalks, asphalt with
// dashed centre lines, and zebra crosswalks at every intersection.
function groundTexture() {
  var S = 2048, span = NV.CITY.SPAN, half = NV.CITY.HALF;
  var px = function (x) { return (x + half) / span * S; };
  var pw = function (w) { return w / span * S; };
  return NV.canvasTexture(NV.makeCanvas(S, S, function (g) {
    g.fillStyle = '#8d8168';
    g.fillRect(0, 0, S, S);
    var i, j, k;
    // Block pavement.
    for (i = 0; i < NV.CITY.GRID; i++) {
      for (j = 0; j < NV.CITY.GRID; j++) {
        var o = NV.blockOrigin(i, j);
        g.fillStyle = (i + j) % 2 ? '#a79b7e' : '#a1987c';
        g.fillRect(px(o.x), px(o.z), pw(NV.CITY.BLOCK), pw(NV.CITY.BLOCK));
      }
    }
    // Sidewalk bands under the asphalt.
    g.fillStyle = '#b8ac8f';
    for (k = 0; k < NV.CITY.roadCenters.length; k++) {
      var c = NV.CITY.roadCenters[k];
      g.fillRect(px(c - NV.CITY.ROAD / 2 - 3), 0, pw(NV.CITY.ROAD + 6), S);
      g.fillRect(0, px(c - NV.CITY.ROAD / 2 - 3), S, pw(NV.CITY.ROAD + 6));
    }
    // Asphalt.
    g.fillStyle = '#33373d';
    for (k = 0; k < NV.CITY.roadCenters.length; k++) {
      c = NV.CITY.roadCenters[k];
      g.fillRect(px(c - NV.CITY.ROAD / 2), 0, pw(NV.CITY.ROAD), S);
      g.fillRect(0, px(c - NV.CITY.ROAD / 2), S, pw(NV.CITY.ROAD));
    }
    // Dashed centre lines, broken at intersections.
    g.fillStyle = '#d9c25e';
    var dash = pw(4), gap = pw(3.4), halfRoad = NV.CITY.ROAD / 2;
    for (k = 0; k < NV.CITY.roadCenters.length; k++) {
      c = NV.CITY.roadCenters[k];
      for (var t = -half; t < half; t += dash + gap) {
        var nearCross = false;
        for (var m = 0; m < NV.CITY.roadCenters.length; m++) {
          if (Math.abs(t + dash / 2 - NV.CITY.roadCenters[m]) < halfRoad + 2) nearCross = true;
        }
        if (nearCross) continue;
        g.fillRect(px(c) - 1.5, px(t), 3, dash);
        g.fillRect(px(t), px(c) - 1.5, dash, 3);
      }
    }
    // Crosswalks: zebra stripes on all four approaches of every intersection.
    g.fillStyle = '#ddd8cc';
    for (var a = 0; a < NV.CITY.roadCenters.length; a++) {
      for (var b = 0; b < NV.CITY.roadCenters.length; b++) {
        var cx = NV.CITY.roadCenters[a], cz = NV.CITY.roadCenters[b];
        for (var sIdx = -3; sIdx <= 3; sIdx++) {
          if (sIdx === 0) continue;
          var off = sIdx * 2.4;
          g.fillRect(px(cx + off - 0.8), px(cz - halfRoad - 3.4), pw(1.6), pw(3));
          g.fillRect(px(cx + off - 0.8), px(cz + halfRoad + 0.4), pw(1.6), pw(3));
          g.fillRect(px(cx - halfRoad - 3.4), px(cz + off - 0.8), pw(3), pw(1.6));
          g.fillRect(px(cx + halfRoad + 0.4), px(cz + off - 0.8), pw(3), pw(1.6));
        }
      }
    }
    // Garage apron.
    var gar = NV.blockOrigin(4, 4);
    g.fillStyle = '#9d968a';
    g.fillRect(px(gar.x + 8), px(gar.z + 34), pw(40), pw(24));
  }));
}

NV.buildCity = function (scene) {
  var rng = NV.makeRng(20261117);
  var colliders = [];
  var world = { colliders: colliders };
  NV.world = world;

  // Apron: a broad sand plain under and around the city, so the ground does
  // not end in mid-air at the map edge — streets at the border look out over
  // the coastal flat instead of the sky.
  var apron = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 2400),
    new THREE.MeshLambertMaterial({ color: 0x8d8168 })
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.2;
  scene.add(apron);

  // Ground.
  var ground = new THREE.Mesh(
    new THREE.PlaneGeometry(NV.CITY.SPAN, NV.CITY.SPAN),
    new THREE.MeshLambertMaterial({ map: groundTexture() })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);

  // Buildings: 2x2 plots per block, heights rising toward the city centre.
  var facades = [facadeTexture(rng, 0.18), facadeTexture(rng, 0.3), facadeTexture(rng, 0.1)];
  var roofMat = new THREE.MeshLambertMaterial({ color: 0x5c564c });
  var tints = [0xffffff, 0xf2d8b8, 0xbfd4e0, 0xe8c8c0, 0xd8e4c8, 0xfff2cc];
  var boxGeoCache = {};
  function buildingMesh(w, h, d, tint, facade) {
    var key = w + 'x' + h + 'x' + d;
    var geo = boxGeoCache[key];
    if (!geo) { geo = new THREE.BoxGeometry(w, h, d); boxGeoCache[key] = geo; }
    var side = new THREE.MeshLambertMaterial({ map: facade, color: tint });
    return new THREE.Mesh(geo, [side, side, roofMat, roofMat, side, side]);
  }

  var emptyPlots = []; // plots the building pass skipped, dressed as lots below
  for (var i = 0; i < NV.CITY.GRID; i++) {
    for (var j = 0; j < NV.CITY.GRID; j++) {
      if (i === 4 && j === 4) continue; // the garage block, built below
      var o = NV.blockOrigin(i, j);
      var centreBoost = 1 - (Math.abs(i - 2) + Math.abs(j - 2)) / 6;
      for (var a = 0; a < 2; a++) {
        for (var b = 0; b < 2; b++) {
          if (rng() < 0.12) { // a few empty plots break up the grid
            emptyPlots.push({ x: o.x + 14 + a * 28, z: o.z + 14 + b * 28 });
            continue;
          }
          var w = NV.randRange(rng, 19, 25), d = NV.randRange(rng, 19, 25);
          var h = 10 + centreBoost * 26 + rng() * 15;
          var cx = o.x + 14 + a * 28, cz = o.z + 14 + b * 28;
          var mesh = buildingMesh(Math.round(w), Math.round(h), Math.round(d),
            NV.randPick(rng, tints), NV.randPick(rng, facades));
          mesh.position.set(cx, h / 2, cz);
          scene.add(mesh);
          colliders.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 });
        }
      }
    }
  }

  // The garage: a wide, low workshop on block (4,4) fronting the south road.
  var go = NV.blockOrigin(4, 4);
  var garage = new THREE.Group();
  var gBody = new THREE.Mesh(
    new THREE.BoxGeometry(36, 10, 20),
    new THREE.MeshLambertMaterial({ color: 0xbfb49a })
  );
  gBody.position.y = 5;
  garage.add(gBody);
  var gFront = new THREE.Mesh(
    new THREE.PlaneGeometry(36, 10),
    new THREE.MeshLambertMaterial({ map: garageFrontTexture() })
  );
  gFront.position.set(0, 5, 10.06);
  garage.add(gFront);
  garage.position.set(go.x + 28, 0, go.z + 24);
  scene.add(garage);
  colliders.push({
    minX: go.x + 28 - 18, maxX: go.x + 28 + 18,
    minZ: go.z + 24 - 10, maxZ: go.z + 24 + 10
  });
  world.garage = { x: go.x + 28, z: go.z + 46, r: 12 }; // delivery point on the apron

  // Civic signs: hospital (block 0,0) and police station (block 4,0) mark respawn points.
  function addSign(blockI, blockJ, text, bg, fg) {
    var bo = NV.blockOrigin(blockI, blockJ);
    var sign = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 5),
      new THREE.MeshBasicMaterial({ map: signTexture(text, bg, fg) })
    );
    sign.position.set(bo.x + 28, 13, bo.z + 56.4);
    scene.add(sign);
  }
  addSign(0, 0, 'PALMERA GENERAL', '#e8e8e8', '#c0272d');
  addSign(4, 0, 'PALMERA PD', '#274b63', '#ffffff');
  world.hospital = { x: -150, z: -186 };
  world.policeStation = { x: 150, z: -186 };

  // Streetlights: instanced poles and lamp heads at intersection corners.
  var lampPositions = [];
  for (var li = 0; li < NV.CITY.roadCenters.length; li++) {
    for (var lj = 0; lj < NV.CITY.roadCenters.length; lj++) {
      lampPositions.push([NV.CITY.roadCenters[li] + 11, NV.CITY.roadCenters[lj] + 11]);
      lampPositions.push([NV.CITY.roadCenters[li] - 11, NV.CITY.roadCenters[lj] - 11]);
    }
  }
  var poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 5.6, 6);
  var poleMat = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });
  var poles = new THREE.InstancedMesh(poleGeo, poleMat, lampPositions.length);
  var headGeo = new THREE.BoxGeometry(0.5, 0.18, 0.5);
  var headMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });
  var heads = new THREE.InstancedMesh(headGeo, headMat, lampPositions.length);
  var m4 = new THREE.Matrix4();
  lampPositions.forEach(function (p, idx) {
    m4.makeTranslation(p[0], 2.8, p[1]);
    poles.setMatrixAt(idx, m4);
    m4.makeTranslation(p[0], 5.65, p[1]);
    heads.setMatrixAt(idx, m4);
  });
  scene.add(poles);
  scene.add(heads);

  // Palms on block corners: a leaning trunk and a blob of foliage.
  var trunkMat = new THREE.MeshLambertMaterial({ color: 0x8a6b48 });
  var leafMat = new THREE.MeshLambertMaterial({ color: 0x4d8a3d });
  for (var p = 0; p < 30; p++) {
    var bi = Math.floor(rng() * 5), bj = Math.floor(rng() * 5);
    var bo2 = NV.blockOrigin(bi, bj);
    var px2 = bo2.x + (rng() < 0.5 ? 2 : NV.CITY.BLOCK - 2);
    var pz2 = bo2.z + (rng() < 0.5 ? 2 : NV.CITY.BLOCK - 2);
    var palm = new THREE.Group();
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, 4.6, 6), trunkMat);
    trunk.position.y = 2.3;
    trunk.rotation.z = NV.randRange(rng, -0.12, 0.12);
    palm.add(trunk);
    var crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 0), leafMat);
    crown.scale.y = 0.55;
    crown.position.y = 4.9;
    palm.add(crown);
    palm.position.set(px2, 0, pz2);
    scene.add(palm);
  }

  // Props: crates and striped barriers, mostly near the garage and a few alleys.
  var crateMat = new THREE.MeshLambertMaterial({ map: woodTexture() });
  var barrierMat = new THREE.MeshLambertMaterial({ map: stripesTexture() });
  function addProp(mat, w, h, d, x, z, ry) {
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, h / 2, z);
    mesh.rotation.y = ry || 0;
    scene.add(mesh);
    colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  }
  for (var cp = 0; cp < 14; cp++) {
    var nearGarage = cp < 8;
    var cxp = nearGarage ? go.x + NV.randRange(rng, 2, 52) : NV.randRange(rng, -180, 180);
    var czp = nearGarage ? go.z + NV.randRange(rng, 40, 54) : NV.randRange(rng, -180, 180);
    addProp(crateMat, 1.3, 1.3, 1.3, cxp, czp, rng() * 1.5);
  }
  for (var bp = 0; bp < 10; bp++) {
    addProp(barrierMat, 2.2, 0.9, 0.5,
      NV.randPick(rng, NV.CITY.roadCenters) + NV.randRange(rng, -4, 4),
      NV.randPick(rng, NV.CITY.roadCenters) + NV.randRange(rng, -4, 4), rng() * 1.5);
  }

  // Block interiors: the plots no building took become parking lots, a couple of
  // basketball courts, or crate yards, so blocks are places and not just facades.
  // Parking lots report car spots to the game (world.parkingSpots) so real,
  // stealable cars wait in them.
  var dumpsterMat = new THREE.MeshLambertMaterial({ color: 0x3f6b4f });
  var slabGeo = new THREE.PlaneGeometry(26, 26);
  world.parkingSpots = [];
  function addSlab(x, z, color) {
    var slab = new THREE.Mesh(slabGeo, new THREE.MeshLambertMaterial({ color: color }));
    slab.rotation.x = -Math.PI / 2;
    slab.position.set(x, 0.03, z);
    scene.add(slab);
  }
  function addHoop(x, z, ry) {
    var hoop = new THREE.Group();
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.6, 6),
      new THREE.MeshLambertMaterial({ color: 0x3a3f45 }));
    pole.position.y = 1.8;
    hoop.add(pole);
    var board = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.1, 0.08),
      new THREE.MeshLambertMaterial({ color: 0xe8e4da }));
    board.position.set(0, 3.3, 0.35);
    hoop.add(board);
    var rim = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 6, 12),
      new THREE.MeshBasicMaterial({ color: 0xe06426 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, 3.0, 0.62);
    hoop.add(rim);
    hoop.position.set(x, 0, z);
    hoop.rotation.y = ry;
    scene.add(hoop);
    colliders.push({ minX: x - 0.3, maxX: x + 0.3, minZ: z - 0.3, maxZ: z + 0.3 });
  }
  emptyPlots.forEach(function (plot, idx) {
    var kind = rng();
    if (kind < 0.55) {
      // Parking lot: dark slab, a dumpster and crates at the edges, car spots.
      addSlab(plot.x, plot.z, 0x3a3e44);
      addProp(dumpsterMat, 2.4, 1.35, 1.25, plot.x - 10.5, plot.z - 10.5, 0.2);
      addProp(crateMat, 1.3, 1.3, 1.3, plot.x + 11, plot.z + 10, rng() * 1.5);
      addProp(crateMat, 1.3, 1.3, 1.3, plot.x + 11, plot.z + 8.4, rng() * 1.5);
      world.parkingSpots.push({ x: plot.x - 5, z: plot.z + 1, heading: Math.PI / 2 });
      world.parkingSpots.push({ x: plot.x + 5, z: plot.z + 1, heading: -Math.PI / 2 });
      if (idx % 2 === 0) world.parkingSpots.push({ x: plot.x, z: plot.z - 7, heading: 0 });
    } else if (kind < 0.8) {
      // Basketball court: warm slab, a hoop at one end, crates as the bench.
      addSlab(plot.x, plot.z, 0x8a5a44);
      addHoop(plot.x, plot.z - 11, 0);
      addProp(crateMat, 1.3, 1.3, 1.3, plot.x - 11, plot.z + 11, rng() * 1.5);
      addProp(dumpsterMat, 2.4, 1.35, 1.25, plot.x + 10.5, plot.z + 11, -0.15);
    } else {
      // Crate yard: stacks and a dumpster, good cover in a chase.
      addProp(crateMat, 1.3, 1.3, 1.3, plot.x - 3, plot.z - 2, rng() * 1.5);
      addProp(crateMat, 1.3, 1.3, 1.3, plot.x - 3, plot.z - 0.5, rng() * 1.5);
      addProp(crateMat, 1.3, 1.3, 1.3, plot.x + 2, plot.z + 3, rng() * 1.5);
      addProp(dumpsterMat, 2.4, 1.35, 1.25, plot.x + 6, plot.z - 5, 0.4);
    }
  });

  // Distant silhouette towers in the haze, outside the playable grid. Each
  // stands on the ground (base at y=0) and is a touch darker than the sky,
  // so it reads as a hazy tower rather than a hole in the sky.
  var silMat = new THREE.MeshBasicMaterial({ color: 0x7490a8 });
  for (var s = 0; s < 16; s++) {
    var ang = (s / 16) * Math.PI * 2;
    var rad = NV.randRange(rng, 300, 400);
    var silH = NV.randRange(rng, 40, 110);
    var tower = new THREE.Mesh(new THREE.BoxGeometry(30, silH, 30), silMat);
    tower.position.set(Math.cos(ang) * rad, silH / 2, Math.sin(ang) * rad);
    scene.add(tower);
  }

  world.spawn = { x: 0, z: 168, heading: Math.PI }; // on the south sidewalk, facing north
  return world;
};
