// people.js — low-poly humanoids built from boxes, the sidewalk pedestrian crowd
// with flee behaviour, and the witness check the wanted system uses. Pedestrians walk
// loops around block perimeters on the sidewalks; a speeding car or a nearby crime
// sends them running; a car that reaches one knocks it down (a serious crime).
'use strict';

var SKIN_TONES = [0xe8b98d, 0xc68863, 0x8d5a3b, 0xf2c9a4];
var SHIRT_COLORS = [0xd94f3d, 0x3d7bd9, 0x53b06a, 0xe8c832, 0xd97fb8, 0xeeeeee, 0x37b8b2];
var PANTS_COLORS = [0x2e3a4a, 0x5a4632, 0x222222, 0x707a88, 0x74553a];

// A simple articulated figure: torso, head, two arms, two legs, pivots at hips and
// shoulders so the game can swing limbs while walking.
NV.buildHumanoid = function (shirt, pants, skin) {
  var g = new THREE.Group();
  var mat = function (c) { return new THREE.MeshLambertMaterial({ color: c }); };
  var torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.62, 0.28), mat(shirt));
  torso.position.y = 1.06;
  g.add(torso);
  var head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 0.3), mat(skin));
  head.position.y = 1.56;
  g.add(head);
  function limb(w, h, d, color, x, y, z) {
    var pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
    m.position.y = -h / 2;
    pivot.add(m);
    g.add(pivot);
    return pivot;
  }
  g.userData.legL = limb(0.17, 0.78, 0.19, pants, -0.14, 0.78, 0);
  g.userData.legR = limb(0.17, 0.78, 0.19, pants, 0.14, 0.78, 0);
  g.userData.armL = limb(0.13, 0.66, 0.15, shirt, -0.34, 1.32, 0);
  g.userData.armR = limb(0.13, 0.66, 0.15, shirt, 0.34, 1.32, 0);
  return g;
};

// Animate a humanoid's walk cycle in place; the caller moves the group.
NV.walkCycle = function (mesh, phase, amount) {
  var s = Math.sin(phase) * 0.55 * amount;
  mesh.userData.legL.rotation.x = s;
  mesh.userData.legR.rotation.x = -s;
  mesh.userData.armL.rotation.x = -s * 0.8;
  mesh.userData.armR.rotation.x = s * 0.8;
};

// One pedestrian. Its path is the perimeter of a block, walked on the sidewalk
// just outside the block's plots. state: 'walk', 'flee' or 'down'.
NV.Pedestrian = function (scene, rng) {
  this.mesh = NV.buildHumanoid(
    NV.randPick(rng, SHIRT_COLORS), NV.randPick(rng, PANTS_COLORS), NV.randPick(rng, SKIN_TONES));
  var bi = Math.floor(rng() * NV.CITY.GRID), bj = Math.floor(rng() * NV.CITY.GRID);
  var o = NV.blockOrigin(bi, bj);
  this.corners = [
    { x: o.x - 3.4, z: o.z - 3.4 },
    { x: o.x + NV.CITY.BLOCK + 3.4, z: o.z - 3.4 },
    { x: o.x + NV.CITY.BLOCK + 3.4, z: o.z + NV.CITY.BLOCK + 3.4 },
    { x: o.x - 3.4, z: o.z + NV.CITY.BLOCK + 3.4 }
  ];
  if (rng() < 0.5) this.corners.reverse();
  this.wp = Math.floor(rng() * 4);
  var start = this.corners[this.wp];
  this.mesh.position.set(start.x, 0, start.z);
  this.heading = 0;
  this.speed = NV.randRange(rng, 1.1, 1.7);
  this.phase = rng() * 6;
  this.state = 'walk';
  this.stateTime = 0;
  this.fleeFrom = null;
  this.downTime = 0;
  scene.add(this.mesh);
};
NV.Pedestrian.prototype.pos = function () { return this.mesh.position; };

NV.Pedestrian.prototype.update = function (dt, world) {
  var p = this.mesh.position;
  this.stateTime += dt;
  if (this.state === 'down') {
    this.downTime -= dt;
    if (this.downTime <= 0) {
      // Get up, dust off, and resume the loop.
      this.mesh.rotation.x = 0;
      this.mesh.position.y = 0;
      this.state = 'walk';
      this.stateTime = 0;
    }
    return;
  }
  var tx, tz, speed;
  if (this.state === 'flee' && this.fleeFrom) {
    var away = Math.atan2(p.x - this.fleeFrom.x, p.z - this.fleeFrom.z);
    tx = p.x + Math.sin(away) * 12;
    tz = p.z + Math.cos(away) * 12;
    speed = 4.6;
    if (this.stateTime > 3.2) { this.state = 'walk'; this.stateTime = 0; }
  } else {
    var target = this.corners[this.wp];
    tx = target.x; tz = target.z;
    speed = this.speed;
    if (NV.dist2(p.x, p.z, tx, tz) < 1.2) {
      this.wp = (this.wp + 1) % 4;
      return;
    }
  }
  var desired = Math.atan2(tx - p.x, tz - p.z);
  this.heading = NV.angleLerp(this.heading, desired, dt * 6);
  p.x += Math.sin(this.heading) * speed * dt;
  p.z += Math.cos(this.heading) * speed * dt;
  NV.resolveCircle(p, 0.45, world.colliders);
  this.mesh.rotation.y = this.heading;
  this.phase += dt * speed * 3.4;
  NV.walkCycle(this.mesh, this.phase, this.state === 'flee' ? 1.4 : 1);
};

NV.Pedestrian.prototype.knockDown = function () {
  if (this.state === 'down') return false;
  this.state = 'down';
  this.downTime = 6;
  this.mesh.rotation.x = -Math.PI / 2;
  this.mesh.position.y = 0.2;
  return true;
};
NV.Pedestrian.prototype.startle = function (fromPos) {
  if (this.state === 'down') return;
  this.state = 'flee';
  this.stateTime = 0;
  this.fleeFrom = { x: fromPos.x, z: fromPos.z };
};

NV.Peds = {
  list: [],
  spawn: function (scene, rng, count) {
    this.list = [];
    for (var i = 0; i < count; i++) this.list.push(new NV.Pedestrian(scene, rng));
    return this.list;
  },
  update: function (dt, world) {
    for (var i = 0; i < this.list.length; i++) this.list[i].update(dt, world);
  },
  // Did anyone see the point? Used to decide whether a theft was witnessed.
  anyWitness: function (pos, radius) {
    for (var i = 0; i < this.list.length; i++) {
      var ped = this.list[i];
      if (ped.state === 'down') continue;
      var p = ped.pos();
      if (NV.dist2(p.x, p.z, pos.x, pos.z) < radius) return ped;
    }
    return null;
  },
  // Everyone within radius runs from the point.
  startleNear: function (pos, radius) {
    for (var i = 0; i < this.list.length; i++) {
      var p = this.list[i].pos();
      if (NV.dist2(p.x, p.z, pos.x, pos.z) < radius) this.list[i].startle(pos);
    }
  }
};
