// vehicles.js — car meshes, arcade driving physics, grid-following traffic AI and
// police pursuit AI. A car's forward is its local +Z; heading theta maps to the world
// direction (sin theta, 0, cos theta). Building collision uses two circles per car
// (front and rear axle), which hugs walls far better than one big circle.
'use strict';

var CAR_COLORS = [0xd64541, 0x3f7fbf, 0xe0a51f, 0x59a65a, 0xd8d8d8, 0x744a9e, 0x2f3540, 0xe8e2d4];

NV.buildCarMesh = function (color, police) {
  var car = new THREE.Group();
  var bodyMat = new THREE.MeshLambertMaterial({ color: color });
  var body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 4.3), bodyMat);
  body.position.y = 0.58;
  car.add(body);
  var cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.5, 2.0),
    new THREE.MeshLambertMaterial({ color: 0x1c2733 })
  );
  cabin.position.set(0, 1.08, -0.25);
  car.add(cabin);
  // Headlights and tail lights as small emissive boxes.
  var lightMat = new THREE.MeshBasicMaterial({ color: 0xfff2b0 });
  var tailMat = new THREE.MeshBasicMaterial({ color: 0xd23b2e });
  [-0.6, 0.6].forEach(function (x) {
    var hl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.06), lightMat);
    hl.position.set(x, 0.62, 2.16);
    car.add(hl);
    var tl = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), tailMat);
    tl.position.set(x, 0.66, -2.16);
    car.add(tl);
  });
  var wheelGeo = new THREE.CylinderGeometry(0.37, 0.37, 0.3, 10);
  var wheelMat = new THREE.MeshLambertMaterial({ color: 0x17181a });
  var wheels = [], frontPivots = [];
  [[-0.88, 1.35], [0.88, 1.35], [-0.88, -1.35], [0.88, -1.35]].forEach(function (p, idx) {
    var pivot = new THREE.Group();
    pivot.position.set(p[0], 0.37, p[1]);
    var wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    pivot.add(wheel);
    car.add(pivot);
    wheels.push(wheel);
    if (idx < 2) frontPivots.push(pivot);
  });
  car.userData.wheels = wheels;
  car.userData.frontPivots = frontPivots;
  if (police) {
    var bar = new THREE.Group();
    var red = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xff2a2a }));
    red.position.x = -0.3;
    var blue = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.5),
      new THREE.MeshBasicMaterial({ color: 0x2a5bff }));
    blue.position.x = 0.3;
    bar.add(red); bar.add(blue);
    bar.position.set(0, 1.42, -0.25);
    car.add(bar);
    car.userData.lightbar = bar;
    car.userData.lightRed = red;
    car.userData.lightBlue = blue;
  }
  return car;
};

// A Car wraps a mesh with arcade physics state. driver: null (parked), 'player',
// 'traffic' or 'police'. stolen marks cars the player took that were not theirs.
NV.Car = function (scene, opts) {
  this.mesh = NV.buildCarMesh(opts.color, opts.police);
  this.mesh.position.set(opts.x, 0, opts.z);
  this.heading = opts.heading || 0;
  this.speed = 0;
  this.steer = 0;
  this.driver = null;
  this.police = !!opts.police;
  this.stolen = false;
  this.own = !!opts.own;         // the player's own car: taking it is never a crime
  this.ai = null;                // traffic/police state, set by the controllers below
  this.stuckTime = 0;
  this.reverseTime = 0;
  scene.add(this.mesh);
  this.syncMesh();
};
NV.Car.prototype.pos = function () { return this.mesh.position; };
NV.Car.prototype.forward = function () {
  return { x: Math.sin(this.heading), z: Math.cos(this.heading) };
};
NV.Car.prototype.syncMesh = function () {
  this.mesh.rotation.y = this.heading;
  var spin = this.speed * 0.45;
  this.mesh.userData.wheels.forEach(function (w) { w.rotation.x += spin * 0.016; });
  this.mesh.userData.frontPivots.forEach(function (p) { p.rotation.y = this.steer * 0.45; }, this);
};

// Move the car by its speed and resolve building collisions with two circles.
// Returns the impact speed when a wall was hit hard, else 0.
NV.Car.prototype.moveAndCollide = function (dt, colliders) {
  var f = this.forward();
  this.mesh.position.x += f.x * this.speed * dt;
  this.mesh.position.z += f.z * this.speed * dt;
  var impact = 0;
  for (var s = -1; s <= 1; s += 2) {
    var c = {
      x: this.mesh.position.x + f.x * 1.35 * s,
      z: this.mesh.position.z + f.z * 1.35 * s
    };
    if (NV.resolveCircle(c, 1.05, colliders)) {
      this.mesh.position.x += c.x - (this.mesh.position.x + f.x * 1.35 * s);
      this.mesh.position.z += c.z - (this.mesh.position.z + f.z * 1.35 * s);
      if (Math.abs(this.speed) > 4) impact = Math.abs(this.speed);
      this.speed *= -0.22;
    }
  }
  // Keep cars inside the city apron.
  var lim = NV.CITY.HALF - 2;
  this.mesh.position.x = NV.clamp(this.mesh.position.x, -lim, lim);
  this.mesh.position.z = NV.clamp(this.mesh.position.z, -lim, lim);
  return impact;
};

// Player driving model: input throttle -1..1, steer -1..1, handbrake bool.
NV.driveCar = function (car, dt, input, colliders) {
  var maxF = 27, maxR = 9;
  var accel = 15;
  if (input.throttle > 0) car.speed += accel * dt * (car.speed < 0 ? 2.2 : 1);
  else if (input.throttle < 0) car.speed -= accel * dt * (car.speed > 0 ? 2.2 : 1);
  else car.speed -= car.speed * 0.6 * dt; // engine braking / coast
  car.speed -= car.speed * 0.35 * dt;    // drag
  if (input.brake) car.speed -= car.speed * 3.2 * dt;
  car.speed = NV.clamp(car.speed, -maxR, maxF);
  if (Math.abs(car.speed) < 0.08 && input.throttle === 0) car.speed = 0;
  car.steer = NV.lerp(car.steer, input.steer, NV.clamp(dt * 8, 0, 1));
  var turnRate = 1.9 * NV.clamp(Math.abs(car.speed) / 7, 0, 1) * (car.speed < 0 ? -1 : 1);
  car.heading += car.steer * turnRate * dt * (Math.abs(car.speed) > 0.1 ? 1 : 0);
  var impact = car.moveAndCollide(dt, colliders);
  car.syncMesh();
  return impact;
};

// --- Traffic -------------------------------------------------------------
// Traffic cars hop from intersection to intersection along the correct lane.
// ai holds grid indices (ix, iz) of the intersection ahead and a unit heading.
NV.Traffic = {
  cars: [],
  LANE: 2.3,
  spawn: function (scene, rng, count) {
    this.cars = [];
    for (var n = 0; n < count; n++) {
      var ix = 1 + Math.floor(rng() * 4), iz = 1 + Math.floor(rng() * 4);
      var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      var d = NV.randPick(rng, dirs);
      var car = new NV.Car(scene, {
        x: NV.CITY.roadCenters[ix], z: NV.CITY.roadCenters[iz],
        heading: Math.atan2(d[0], d[1]),
        color: NV.randPick(rng, CAR_COLORS)
      });
      car.driver = 'traffic';
      car.ai = { ix: ix, iz: iz, dx: d[0], dz: d[1], rng: rng };
      this.setTarget(car);
      // Start the car at its lane point beside the spawn intersection.
      var t = this.lanePoint(car.ai);
      car.mesh.position.set(t.x, 0, t.z);
      car.syncMesh();
      this.cars.push(car);
    }
    return this.cars;
  },
  // The point a car steers for: the intersection ahead, offset to the right lane.
  lanePoint: function (ai) {
    var cx = NV.CITY.roadCenters[ai.ix], cz = NV.CITY.roadCenters[ai.iz];
    // Right of heading (dx,dz) is (dz, -dx) in world XZ with our heading convention.
    return { x: cx + ai.dz * this.LANE, z: cz - ai.dx * this.LANE };
  },
  setTarget: function (car) {
    var ai = car.ai;
    ai.ix += ai.dx;
    ai.iz += ai.dz;
    ai.tx = this.lanePoint(ai).x;
    ai.tz = this.lanePoint(ai).z;
  },
  pickNextDirection: function (car) {
    var ai = car.ai;
    var options = [];
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var i = 0; i < dirs.length; i++) {
      var d = dirs[i];
      if (d[0] === -ai.dx && d[1] === -ai.dz) continue; // no U-turns
      var nx = ai.ix + d[0], nz = ai.iz + d[1];
      if (nx < 0 || nz < 0 || nx > NV.CITY.GRID || nz > NV.CITY.GRID) continue;
      options.push(d);
    }
    if (!options.length) options.push([-ai.dx, -ai.dz]);
    // Prefer going straight, sometimes turn.
    var straight = options.filter(function (d) { return d[0] === ai.dx && d[1] === ai.dz; });
    var next = (straight.length && ai.rng() < 0.62) ? straight[0] : NV.randPick(ai.rng, options);
    ai.dx = next[0];
    ai.dz = next[1];
  },
  update: function (dt, world, obstaclePoints) {
    var colliders = world.colliders;
    for (var i = 0; i < this.cars.length; i++) {
      var car = this.cars[i], ai = car.ai;
      var p = car.pos();
      var dx = ai.tx - p.x, dz = ai.tz - p.z;
      var distT = Math.sqrt(dx * dx + dz * dz);
      if (distT < 5) {
        this.pickNextDirection(car);
        this.setTarget(car);
      }
      var desired = Math.atan2(dx, dz);
      var diff = NV.wrapAngle(desired - car.heading);
      car.steer = NV.clamp(diff * 1.6, -1, 1);
      car.heading += car.steer * 1.5 * dt * NV.clamp(Math.abs(car.speed) / 5 + 0.25, 0, 1);
      // Desired speed: cruise, slower in a turn, stopped behind an obstacle.
      var want = Math.abs(diff) > 0.7 ? 4.5 : 9.5;
      var f = car.forward();
      for (var o = 0; o < obstaclePoints.length; o++) {
        var ob = obstaclePoints[o];
        var ox = ob.x - p.x, oz = ob.z - p.z;
        var ahead = ox * f.x + oz * f.z;
        var side = Math.abs(ox * f.z - oz * f.x);
        var od = Math.sqrt(ox * ox + oz * oz);
        if (ahead > 0.5 && side < 2.1 && od < 9) { want = 0; break; }
        if (ahead > 0.5 && side < 2.4 && od < 13) want = Math.min(want, 4);
      }
      car.speed = NV.lerp(car.speed, want, NV.clamp(dt * (want < car.speed ? 5 : 1.6), 0, 1));
      car.moveAndCollide(dt, colliders);
      car.syncMesh();
    }
  }
};

// --- Police ---------------------------------------------------------------
// Police cars seek the player directly; when one wedges itself on a building it
// breaks off to the nearest intersection and comes at the player again from the
// road grid, which reads as persistence rather than a stuck car.
NV.Police = {
  cars: [],
  spawnOne: function (scene, world, playerPos) {
    // Spawn at a road intersection at least 55 units away from the player.
    var best = null, bestD = -1, bi = 0, bj = 0;
    for (var i = 0; i < NV.CITY.roadCenters.length; i++) {
      for (var j = 0; j < NV.CITY.roadCenters.length; j++) {
        var x = NV.CITY.roadCenters[i], z = NV.CITY.roadCenters[j];
        var d = NV.dist2(x, z, playerPos.x, playerPos.z);
        if (d > 55 && d < 150 && d > bestD) { bestD = d; best = { x: x, z: z }; bi = i; bj = j; }
      }
    }
    if (!best) best = { x: NV.CITY.roadCenters[0], z: NV.CITY.roadCenters[0] };
    var car = new NV.Car(scene, { x: best.x, z: best.z, heading: 0, color: 0xf2f2f2, police: true });
    car.driver = 'police';
    car.ai = { ramCooldown: 0, escapeTime: 0, escapeTarget: null, anchorX: best.x, anchorZ: best.z, anchorTime: 0, gx: bi, gz: bj };
    this.cars.push(car);
    return car;
  },
  remove: function (scene, car) {
    scene.remove(car.mesh);
    var idx = this.cars.indexOf(car);
    if (idx >= 0) this.cars.splice(idx, 1);
  },
  update: function (dt, world, target, time) {
    var colliders = world.colliders;
    for (var i = this.cars.length - 1; i >= 0; i--) {
      var car = this.cars[i];
      var p = car.pos();
      var d = NV.dist2(p.x, p.z, target.x, target.z);
      if (d > 260) { this.remove(world.scene, car); continue; }
      // Steer point: while far away, follow the road grid from intersection
      // to intersection, greedily closing on the player — a straight line
      // to the player crosses solid blocks and the car just wedges on a
      // building. Close in (or while escaping a wedge), steer directly.
      var steerTarget = target;
      if (car.ai.escapeTime > 0) {
        car.ai.escapeTime -= dt;
        steerTarget = car.ai.escapeTarget;
        if (NV.dist2(p.x, p.z, steerTarget.x, steerTarget.z) < 5) car.ai.escapeTime = 0;
      } else if (d > 26) {
        var gx = car.ai.gx, gz = car.ai.gz;
        var tx = NV.CITY.roadCenters[gx], tz = NV.CITY.roadCenters[gz];
        if (NV.dist2(p.x, p.z, tx, tz) < 6) {
          var opts = [[1, 0], [-1, 0], [0, 1], [0, -1]], bo = null, bd2 = 1e9;
          for (var oi = 0; oi < 4; oi++) {
            var nx = gx + opts[oi][0], nz = gz + opts[oi][1];
            if (nx < 0 || nz < 0 || nx > NV.CITY.GRID || nz > NV.CITY.GRID) continue;
            var dd2 = NV.dist2(NV.CITY.roadCenters[nx], NV.CITY.roadCenters[nz], target.x, target.z);
            if (dd2 < bd2) { bd2 = dd2; bo = [nx, nz]; }
          }
          if (bo) {
            car.ai.gx = bo[0]; car.ai.gz = bo[1];
            tx = NV.CITY.roadCenters[bo[0]]; tz = NV.CITY.roadCenters[bo[1]];
          }
        }
        steerTarget = { x: tx, z: tz };
      }
      var desired = Math.atan2(steerTarget.x - p.x, steerTarget.z - p.z);
      var diff = NV.wrapAngle(desired - car.heading);
      // Unstick: judge progress over a window, not instant speed. A car
      // wedged on a building bounces (hit, recoil, accelerate, hit again),
      // so its speed rarely stays near zero long enough for a speed check
      // to notice — but over 1.4 s it has gone nowhere. Head for the
      // nearest intersection instead of grinding against the building.
      // Skipped while already escaping, and while on top of the player
      // (barely moving there means it is engaging, not stuck).
      if (car.ai.escapeTime <= 0 && d > 6 && time - car.ai.anchorTime > 1.4) {
        if (NV.dist2(p.x, p.z, car.ai.anchorX, car.ai.anchorZ) < 2.5) {
          var bx = NV.CITY.roadCenters[0], bz = NV.CITY.roadCenters[0], bd = 1e9;
          for (var a = 0; a < NV.CITY.roadCenters.length; a++) {
            for (var b = 0; b < NV.CITY.roadCenters.length; b++) {
              var dd = NV.dist2(p.x, p.z, NV.CITY.roadCenters[a], NV.CITY.roadCenters[b]);
              if (dd < bd) { bd = dd; bx = NV.CITY.roadCenters[a]; bz = NV.CITY.roadCenters[b]; }
            }
          }
          car.ai.escapeTarget = { x: bx, z: bz };
          car.ai.escapeTime = 2.2;
        }
        car.ai.anchorX = p.x; car.ai.anchorZ = p.z; car.ai.anchorTime = time;
      }
      car.steer = NV.clamp(diff * 1.9, -1, 1);
      car.heading += car.steer * 2.0 * dt * NV.clamp(Math.abs(car.speed) / 6 + 0.3, 0, 1) * (car.speed < 0 ? -1 : 1);
      var maxSpeed = d > 34 ? 19.5 : 15;
      car.speed = Math.min(car.speed + 13 * dt, maxSpeed);
      car.speed -= car.speed * 0.25 * dt;
      car.moveAndCollide(dt, colliders);
      car.syncMesh();
      // Flash the lightbar.
      if (car.mesh.userData.lightbar) {
        var phase = Math.floor(time * 5) % 2;
        car.mesh.userData.lightRed.visible = phase === 0;
        car.mesh.userData.lightBlue.visible = phase === 1;
      }
      car.ai.ramCooldown = Math.max(0, car.ai.ramCooldown - dt);
    }
  }
};

// Pairwise car-vs-car soft collision. Calls onHit(a, b, relSpeed) for hard contacts
// so the game can raise wanted level and play a thud. Parked cars do not move.
NV.collideCars = function (cars, onHit) {
  for (var i = 0; i < cars.length; i++) {
    for (var j = i + 1; j < cars.length; j++) {
      var a = cars[i], b = cars[j];
      var pa = a.pos(), pb = b.pos();
      var dx = pb.x - pa.x, dz = pb.z - pa.z;
      var d2 = dx * dx + dz * dz, min = 3.4;
      if (d2 < min * min && d2 > 1e-4) {
        var d = Math.sqrt(d2);
        var push = (min - d) / 2;
        var nx = dx / d, nz = dz / d;
        var aFree = a.driver !== null, bFree = b.driver !== null;
        if (aFree) { pa.x -= nx * push * (bFree ? 1 : 2); pa.z -= nz * push * (bFree ? 1 : 2); }
        if (bFree) { pb.x += nx * push * (aFree ? 1 : 2); pb.z += nz * push * (aFree ? 1 : 2); }
        var rel = Math.abs(a.speed - b.speed);
        if (rel > 3.5) {
          if (aFree) a.speed *= 0.45;
          if (bFree) b.speed *= 0.45;
          if (onHit) onHit(a, b, rel);
        }
      }
    }
  }
};
