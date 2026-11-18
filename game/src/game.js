// game.js — Palmera Nights, the playable loop. Owns the scene, the player (on foot
// and in cars), the wanted system and police response, Rosa Delgado's five-mission
// chain, fists-and-pistol combat, the localStorage save, the HUD and minimap, and
// the title / pause flow. The world steps at a fixed 120 Hz so speed never depends
// on the frame rate. Other files build the world (city.js), the cars and their AI
// (vehicles.js), the crowd (people.js), the sound (audio.js) and the helpers
// (util.js); this file wires them together.
'use strict';

(function () {
  // URL params drive only the screenshot/test hook at the bottom of this file
  // (and an optional layout seed); normal play passes none and is unchanged.
  var params = new URLSearchParams(window.location.search);
  var seedParam = parseInt(params.get('seed'), 10);
  var rng = NV.makeRng(isNaN(seedParam) ? 112233 : seedParam);

  // --- Scene -------------------------------------------------------------
  var container = document.getElementById('scene');
  var renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  container.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fc3e8);
  scene.fog = new THREE.Fog(0xa9c8e0, 90, 430);
  var camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 900);

  var sun = new THREE.DirectionalLight(0xffe3b3, 0.95);
  sun.position.set(90, 140, 50);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x8a7a5a, 0.8));

  var world = NV.buildCity(scene);
  world.scene = scene;

  // --- DOM ----------------------------------------------------------------
  var el = {};
  ['startScreen', 'pauseScreen', 'hud', 'healthFill', 'money', 'stars', 'speed',
   'objective', 'prompt', 'toast', 'minimap', 'wantedLabel', 'weapon', 'timer',
   'crosshair', 'playHint', 'menuButtons', 'continueBtn', 'newGameBtn',
   'saveBtn', 'saveNote'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });
  var mapCtx = el.minimap.getContext('2d');

  // --- Player ---------------------------------------------------------------
  var player = {
    mesh: NV.buildHumanoid(0x27324a, 0x1d1d22, 0xe8b98d),
    heading: Math.PI,
    health: 100,
    money: 120,
    mode: 'foot',          // 'foot' or 'car'
    car: null,
    walkPhase: 0,
    bustTimer: 0,
    // Combat: a pistol taken at the garage, its magazine and spare rounds,
    // and the clocks that pace punches, shots and the reload.
    hasPistol: false,
    ammo: 0,
    reserve: 0,
    attackCd: 0,
    reloadAt: 0,
    punchUntil: 0
  };
  player.mesh.position.set(world.spawn.x, 0, world.spawn.z);
  scene.add(player.mesh);

  // --- Cars -----------------------------------------------------------------
  var allCars = [];
  // The player's own car, parked by the spawn: taking it is never a crime.
  var ownCar = new NV.Car(scene, { x: 6.5, z: 177.6, heading: Math.PI / 2, color: 0x1fa8a0, own: true });
  allCars.push(ownCar);
  // Parked cars along the curbs, waiting to be stolen.
  for (var pi = 0; pi < 10; pi++) {
    var vertical = rng() < 0.5;
    var rc = NV.randPick(rng, NV.CITY.roadCenters);
    var along = NV.randRange(rng, -175, 175);
    var side = rng() < 0.5 ? -7.4 : 7.4;
    var parked = new NV.Car(scene, {
      x: vertical ? rc + side : along,
      z: vertical ? along : rc + side,
      heading: vertical ? (side > 0 ? Math.PI : 0) : (side > 0 ? Math.PI / 2 : -Math.PI / 2),
      color: NV.randPick(rng, CAR_COLORS)
    });
    allCars.push(parked);
  }
  var trafficCars = NV.Traffic.spawn(scene, rng, 8);
  allCars = allCars.concat(trafficCars);
  // More parked cars wait in the parking lots city.js dressed (world.parkingSpots).
  (world.parkingSpots || []).forEach(function (spot, si) {
    if (si % 2 === 1) return; // leave half the spots empty
    var lotCar = new NV.Car(scene, {
      x: spot.x, z: spot.z, heading: spot.heading,
      color: NV.randPick(rng, CAR_COLORS)
    });
    allCars.push(lotCar);
  });
  NV.Peds.spawn(scene, rng, 14);

  // --- Game state -------------------------------------------------------------
  var G = {
    state: 'title',        // title | playing | paused
    time: 0,
    camYaw: Math.PI,
    camPitch: 0.34,
    driveYawOffset: 0,
    wanted: { heat: 0, lastCrime: -99 },
    policeCooldown: 0,
    mission: 0,            // index into the chain below; 5 = chain done, free roam
    md: {},                // per-mission scratch state, set by startMission
    toastUntil: 0
  };
  var keys = {};
  var OBJECTIVES = [
    'Reach Delgado Auto Works — follow the gold marker',
    'Steal any car and deliver it to the garage apron',
    'Special delivery: take Rosa\'s gold car across town before the clock runs out',
    'Pick up the package across town, then bring it to the garage — expect heat',
    'Repo job: steal the marked purple car and bring it back to the garage',
    'Free roam — Palmera is yours. Stolen cars fetch $150 scrap at the garage'
  ];
  // Mission geography: the drop is the north-west intersection, the package
  // waits in the south-west, the repo car is parked up north.
  var DROP_POINT = { x: -111, z: -111, r: 12 };
  var PACKAGE_POINT = { x: -158, z: 148 };
  var REPO_SPOT = { x: 44.4, z: -52, heading: 0 };
  var deliveryCar = null;  // Rosa's gold car, spawned for mission 2
  var repoCar = null;      // the marked car of mission 4
  var owner = null;        // the repo car's angry owner, a guard NPC

  // The gold beacon that marks the current objective in the world: a soft
  // pillar of light you can see across rooftops, with a spinning diamond.
  var marker = new THREE.Group();
  var pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.5, 34, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffd94d, transparent: true, opacity: 0.28,
      side: THREE.DoubleSide, depthWrite: false
    })
  );
  pillar.position.y = 17;
  marker.add(pillar);
  var gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.85),
    new THREE.MeshBasicMaterial({ color: 0xffd94d })
  );
  gem.position.y = 3.4;
  marker.add(gem);
  scene.add(marker);

  // The package of mission 3: a small bright case, waiting to be picked up.
  var packageMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.3, 0.44),
    new THREE.MeshBasicMaterial({ color: 0xffb52e })
  );
  packageMesh.position.set(PACKAGE_POINT.x, 0.35, PACKAGE_POINT.z);
  packageMesh.visible = false;
  scene.add(packageMesh);

  // The pistol pickup at the garage: a dark little gun on a gold pad. It
  // appears once the intro chain is done; taking it also refills the ammo.
  var PISTOL_POINT = { x: world.garage.x - 9, z: world.garage.z - 4 };
  var pistolMesh = new THREE.Group();
  var pad = new THREE.Mesh(
    new THREE.CylinderGeometry(0.85, 0.85, 0.08, 16),
    new THREE.MeshBasicMaterial({ color: 0xffd94d })
  );
  pad.position.y = 0.04;
  pistolMesh.add(pad);
  var gunBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.14, 0.52),
    new THREE.MeshLambertMaterial({ color: 0x22242a })
  );
  gunBody.position.y = 0.3;
  pistolMesh.add(gunBody);
  var gunGrip = new THREE.Mesh(
    new THREE.BoxGeometry(0.13, 0.3, 0.16),
    new THREE.MeshLambertMaterial({ color: 0x3a2c1c })
  );
  gunGrip.position.set(0, 0.14, -0.16);
  pistolMesh.add(gunGrip);
  pistolMesh.position.set(PISTOL_POINT.x, 0, PISTOL_POINT.z);
  pistolMesh.visible = false;
  scene.add(pistolMesh);

  // Muzzle flash: a bright sphere plus a point light, lit for a few frames.
  var flashMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffe9a0 })
  );
  flashMesh.visible = false;
  scene.add(flashMesh);
  var flashLight = new THREE.PointLight(0xffc266, 0, 16);
  scene.add(flashLight);
  var flashUntil = 0;

  function stars() {
    if (G.wanted.heat <= 0.05) return 0;
    return NV.clamp(Math.ceil(G.wanted.heat), 1, 5);
  }

  function toast(text, seconds) {
    el.toast.textContent = text;
    el.toast.style.opacity = '1';
    G.toastUntil = G.time + (seconds || 3);
  }

  // Crime raises heat; nearby pedestrians panic. Witnessed thefts cost a full star,
  // quiet ones much less; running someone down is the worst everyday crime.
  function commitCrime(kind, pos) {
    var add = {
      theft: 1.0, theftQuiet: 0.35, hitPed: 2.0, hitCar: 0.6, hitPolice: 1.2,
      assault: 0.7, shooting: 2.2
    }[kind] || 0.5;
    G.wanted.heat = Math.min(6, G.wanted.heat + add);
    G.wanted.lastCrime = G.time;
    NV.Peds.startleNear(pos, 17);
  }

  function clearPolice() {
    while (NV.Police.cars.length) NV.Police.remove(scene, NV.Police.cars[0]);
  }

  function respawn(point, fine, label) {
    if (player.mode === 'car' && player.car) { player.car.driver = null; player.car = null; }
    player.mode = 'foot';
    player.mesh.visible = true;
    player.mesh.position.set(point.x, 0, point.z);
    player.health = 100;
    player.money = Math.max(0, player.money - fine);
    G.wanted.heat = 0;
    clearPolice();
    // Caught or hospitalised while carrying the package: it is gone, and
    // Rosa's pickup has to be run again from the top.
    var note = '';
    if (G.mission === 3 && G.md.carrying) {
      G.md.carrying = false;
      packageMesh.visible = true;
      note = ' The package is gone — fetch it again.';
    }
    toast(label + ' — $' + fine + ' gone. You are back on the street.' + note, 4);
  }

  // --- Input ------------------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    keys[e.code] = true;
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'KeyM') {
      var muted = NV.Sound.toggleMute();
      toast(muted ? 'Sound off' : 'Sound on', 1.2);
    }
    if (e.code === 'KeyE' && G.state === 'playing') tryInteract();
    if (e.code === 'KeyF' && G.state === 'playing') tryPunch();
    if (e.code === 'KeyR' && G.state === 'playing') tryReload();
  });
  document.addEventListener('keyup', function (e) { keys[e.code] = false; });
  // Left mouse: shoot when armed, punch when not. Clicks that start or resume
  // the game land while the state is still title/paused, so they never attack.
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || G.state !== 'playing' || player.mode !== 'foot') return;
    if (player.hasPistol) tryShoot();
    else tryPunch();
  });
  document.addEventListener('mousemove', function (e) {
    if (G.state !== 'playing' || document.pointerLockElement !== renderer.domElement) return;
    if (player.mode === 'car') {
      G.driveYawOffset = NV.clamp(G.driveYawOffset - e.movementX * 0.0024, -1.2, 1.2);
    } else {
      G.camYaw -= e.movementX * 0.0026;
    }
    G.camPitch = NV.clamp(G.camPitch + e.movementY * 0.0022, -0.12, 1.05);
  });
  document.addEventListener('pointerlockchange', function () {
    if (document.pointerLockElement !== renderer.domElement && G.state === 'playing') {
      G.state = 'paused';
      el.pauseScreen.style.display = 'flex';
      NV.Sound.engine(false, 0, 0);
      NV.Sound.siren(false, 0);
    }
  });
  function lockAndPlay() {
    NV.Sound.init();
    renderer.domElement.requestPointerLock();
    el.startScreen.style.display = 'none';
    el.pauseScreen.style.display = 'none';
    el.hud.style.display = 'block';
    G.state = 'playing';
  }

  // --- Save / load ----------------------------------------------------------
  // One localStorage slot: money, health, mission progress, where the player
  // stands and the car they were driving (boot cars restore exactly; anything
  // else respawns on foot at the saved spot). Wanted is always cleared.
  var SAVE_KEY = 'palmera-nights-save-v1';
  function hasSave() {
    try { return !!window.localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  }
  function saveGame(announce) {
    try {
      var pt = playerPoint();
      var carIdx = -1, stolen = false;
      if (player.mode === 'car' && player.car &&
          NV.Traffic.cars.indexOf(player.car) === -1 && !player.car.police) {
        carIdx = allCars.indexOf(player.car);
        stolen = !!player.car.stolen;
      }
      var data = {
        money: Math.floor(player.money),
        health: Math.round(player.health),
        mission: G.mission,
        x: pt.x, z: pt.z,
        heading: player.mode === 'car' && player.car ? player.car.heading : player.heading,
        carIdx: carIdx, stolen: stolen,
        carX: player.car ? player.car.pos().x : 0,
        carZ: player.car ? player.car.pos().z : 0,
        hasPistol: player.hasPistol, ammo: player.ammo, reserve: player.reserve
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      if (announce) toast('Saved', 1.4);
      return true;
    } catch (e) { return false; }
  }
  function applySave() {
    var data = null;
    try { data = JSON.parse(window.localStorage.getItem(SAVE_KEY)); } catch (e) { /* no save */ }
    if (!data) return false;
    player.money = data.money || 0;
    player.health = NV.clamp(data.health || 100, 25, 100);
    player.hasPistol = !!data.hasPistol;
    player.ammo = data.ammo || 0;
    player.reserve = data.reserve || 0;
    G.mission = NV.clamp(data.mission || 0, 0, OBJECTIVES.length - 1);
    startMission(G.mission); // rebuilds this mission's props and objective
    G.wanted.heat = 0;
    clearPolice();
    if (data.carIdx >= 0 && allCars[data.carIdx]) {
      var car = allCars[data.carIdx];
      car.mesh.position.set(data.carX, 0, data.carZ);
      car.heading = data.heading || 0;
      car.speed = 0;
      car.stolen = !!data.stolen;
      car.syncMesh();
      car.driver = 'player';
      player.car = car;
      player.mode = 'car';
      player.mesh.visible = false;
      G.camYaw = car.heading;
    } else {
      player.mesh.position.set(data.x || world.spawn.x, 0, data.z || world.spawn.z);
      player.heading = data.heading || Math.PI;
      G.camYaw = player.heading;
    }
    el.objective.textContent = OBJECTIVES[G.mission];
    return true;
  }
  function refreshStartMenu() {
    var saved = hasSave();
    el.menuButtons.style.display = saved ? 'flex' : 'none';
    el.playHint.textContent = saved ? 'CLICK TO CONTINUE' : 'CLICK TO PLAY';
  }
  el.startScreen.addEventListener('click', function () {
    if (hasSave()) applySave();
    lockAndPlay();
  });
  el.continueBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    applySave();
    lockAndPlay();
  });
  el.newGameBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    try { window.localStorage.removeItem(SAVE_KEY); } catch (err) { /* ignore */ }
    window.location.reload(); // a fresh world, no half-reset state
  });
  el.pauseScreen.addEventListener('click', lockAndPlay);
  el.saveBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    el.saveNote.textContent = saveGame(false) ? 'Game saved' : 'Save failed — storage unavailable';
  });
  refreshStartMenu();
  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- Interaction: enter / exit cars ------------------------------------------
  function nearestEnterableCar() {
    var p = player.mesh.position, best = null, bestD = 3.8;
    for (var i = 0; i < allCars.length; i++) {
      var car = allCars[i];
      if (car.police || car.driver === 'player') continue;
      if (Math.abs(car.speed) > 1.5) continue;
      var d = NV.dist2(p.x, p.z, car.pos().x, car.pos().z);
      if (d < bestD) { bestD = d; best = car; }
    }
    return best;
  }

  function exitCar() {
    var car = player.car;
    var f = car.forward();
    player.mesh.position.set(car.pos().x - f.z * 2.0, 0, car.pos().z + f.x * 2.0);
    NV.resolveCircle(player.mesh.position, 0.45, world.colliders);
    player.mesh.visible = true;
    player.heading = car.heading;
    car.driver = null;
    player.car = null;
    player.mode = 'foot';
    NV.Sound.engine(false, 0, 0);
  }

  function nearPistol() {
    return G.mission >= 2 && player.mode === 'foot' &&
      NV.dist2(player.mesh.position.x, player.mesh.position.z,
        PISTOL_POINT.x, PISTOL_POINT.z) < 2.4;
  }

  function tryInteract() {
    if (player.mode === 'car') { exitCar(); return; }
    // The pistol at the garage comes before car doors: it sits on the apron.
    if (nearPistol()) {
      var fresh = !player.hasPistol;
      player.hasPistol = true;
      player.ammo = 12;
      player.reserve = 48;
      player.reloadAt = 0;
      NV.Sound.jingle();
      toast(fresh ? 'You take Rosa\'s pistol. Click to shoot, R to reload.'
                  : 'Pistol reloaded — Rosa keeps the ammo box full.', 3);
      return;
    }
    var target = nearestEnterableCar();
    if (!target) return;
    if (target.driver === 'traffic') target.driver = null; // driver bails, unseen
    target.driver = 'player';
    player.car = target;
    player.mode = 'car';
    player.mesh.visible = false;
    if (!target.own && !target.stolen) {
      target.stolen = true;
      var witness = NV.Peds.anyWitness(target.pos(), 26);
      commitCrime(witness ? 'theft' : 'theftQuiet', target.pos());
      toast(witness ? 'Grand theft — and somebody saw it.' : 'Grand theft — nobody saw a thing.', 2.5);
    }
  }

  // --- Combat -------------------------------------------------------------------
  // Fists and the pistol, both on foot. Attacks aim where the camera looks:
  // a punch checks a short cone ahead, a shot casts a ray from the camera and
  // takes the nearest body or car it passes close enough to.
  function lookDir() {
    var v = new THREE.Vector3();
    camera.getWorldDirection(v);
    return v;
  }

  // Is this figure inside the punch cone / the bullet's path? Returns the
  // distance along the look direction, or -1 for a miss.
  function aimScore(origin, dir, px, py, pz, radius) {
    var vx = px - origin.x, vy = py - origin.y, vz = pz - origin.z;
    var t = vx * dir.x + vy * dir.y + vz * dir.z;
    if (t < 0.4) return -1;
    var cx = origin.x + dir.x * t, cy = origin.y + dir.y * t, cz = origin.z + dir.z * t;
    var d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy) + (pz - cz) * (pz - cz);
    return d2 < radius * radius ? t : -1;
  }

  function hitFigure(fig, byGun) {
    // fig: {ped} for a pedestrian, {owner:true} for the repo car's owner.
    if (fig.owner) {
      if (!owner || !owner.active || G.time < owner.downUntil) return;
      owner.downUntil = G.time + (byGun ? 30 : 4);
      owner.mesh.rotation.x = -Math.PI / 2;
      owner.mesh.position.y = 0.2;
      NV.Sound.thud(0.6);
      return;
    }
    var ped = fig.ped;
    if (ped.state === 'down') return;
    if (ped.knockDown()) {
      if (byGun) ped.downTime = 45; // shot victims stay down
      NV.Sound.thud(byGun ? 0.5 : 0.45);
    }
  }

  function tryPunch() {
    if (player.mode !== 'foot' || G.time < player.attackCd) return;
    player.attackCd = G.time + 0.38;
    player.punchUntil = G.time + 0.22;
    var p = player.mesh.position;
    var origin = { x: p.x, y: 1.3, z: p.z };
    var dir = lookDir();
    var best = null, bestT = 2.6;
    for (var i = 0; i < NV.Peds.list.length; i++) {
      var ped = NV.Peds.list[i];
      if (ped.state === 'down') continue;
      var pp = ped.pos();
      var t = aimScore(origin, dir, pp.x, 1.0, pp.z, 1.05);
      if (t > 0 && t < bestT) { bestT = t; best = { ped: ped }; }
    }
    if (owner && owner.active && G.time >= owner.downUntil) {
      var op = owner.mesh.position;
      var ot = aimScore(origin, dir, op.x, 1.0, op.z, 1.05);
      if (ot > 0 && ot < bestT) { bestT = ot; best = { owner: true }; }
    }
    if (best) {
      hitFigure(best, false);
      // A witnessed assault is a crime, a quiet one is just a bad day.
      if (NV.Peds.anyWitness(p, 20)) {
        commitCrime('assault', p);
        toast('You decked them in front of witnesses.', 2);
      }
    }
  }

  function tryShoot() {
    if (player.mode !== 'foot' || !player.hasPistol) return;
    if (G.time < player.attackCd || G.time < player.reloadAt) return;
    if (player.ammo <= 0) {
      player.attackCd = G.time + 0.3;
      toast(player.reserve > 0 ? 'Magazine empty — R to reload.' : 'No ammo — Rosa\'s pad at the garage refills it.', 1.6);
      return;
    }
    player.ammo--;
    player.attackCd = G.time + 0.24;
    NV.Sound.gunshot();
    var p = player.mesh.position;
    var dir = lookDir();
    // Muzzle flash at the gun hand, lit for a few frames.
    flashMesh.position.set(p.x + dir.x * 0.7, 1.32, p.z + dir.z * 0.7);
    flashMesh.visible = true;
    flashLight.position.copy(flashMesh.position);
    flashLight.intensity = 2.4;
    flashUntil = G.time + 0.055;
    var origin = { x: p.x, y: 1.42, z: p.z };
    var best = null, bestT = 70;
    for (var i = 0; i < NV.Peds.list.length; i++) {
      var ped = NV.Peds.list[i];
      if (ped.state === 'down') continue;
      var pp = ped.pos();
      var t = aimScore(origin, dir, pp.x, 1.0, pp.z, 0.95);
      if (t > 0 && t < bestT) { bestT = t; best = { ped: ped }; }
    }
    if (owner && owner.active && G.time >= owner.downUntil) {
      var op = owner.mesh.position;
      var ot = aimScore(origin, dir, op.x, 1.0, op.z, 0.95);
      if (ot > 0 && ot < bestT) { bestT = ot; best = { owner: true }; }
    }
    var hitSomething = !!best;
    if (!hitSomething) {
      // Cars soak bullets with a clang and a dented panel's worth of noise.
      var all = allCars.concat(NV.Police.cars);
      for (var ci = 0; ci < all.length; ci++) {
        var cp = all[ci].pos();
        var ct = aimScore(origin, dir, cp.x, 0.75, cp.z, 2.1);
        if (ct > 0 && ct < bestT) { bestT = ct; hitSomething = true; }
      }
      if (hitSomething) NV.Sound.thud(0.35);
    }
    if (best) hitFigure(best, true);
    // Gunfire is the loudest crime there is: everyone runs, the PPD comes.
    commitCrime('shooting', p);
    NV.Peds.startleNear(p, 26);
    if (player.ammo === 0 && player.reserve > 0) tryReload();
  }

  function tryReload() {
    if (!player.hasPistol || player.mode !== 'foot') return;
    if (G.time < player.reloadAt || player.ammo >= 12 || player.reserve <= 0) return;
    player.reloadAt = G.time + 0.9;
    NV.Sound.reloadClick();
  }

  // --- Per-frame updates ---------------------------------------------------------
  function playerPoint() {
    if (player.mode === 'car' && player.car) {
      var cp = player.car.pos();
      return { x: cp.x, z: cp.z };
    }
    var pp = player.mesh.position;
    return { x: pp.x, z: pp.z };
  }

  function updatePlayerOnFoot(dt) {
    var p = player.mesh.position;
    var lx = Math.sin(G.camYaw), lz = Math.cos(G.camYaw);
    var rx = -lz, rz = lx; // right of the camera's look direction
    var mx = 0, mz = 0;
    if (keys.KeyW) { mx += lx; mz += lz; }
    if (keys.KeyS) { mx -= lx; mz -= lz; }
    if (keys.KeyD) { mx += rx; mz += rz; }
    if (keys.KeyA) { mx -= rx; mz -= rz; }
    var len = Math.sqrt(mx * mx + mz * mz);
    var sprint = keys.ShiftLeft || keys.ShiftRight;
    var speed = sprint ? 8.6 : 5.2;
    if (len > 0.01) {
      mx /= len; mz /= len;
      p.x += mx * speed * dt;
      p.z += mz * speed * dt;
      player.heading = NV.angleLerp(player.heading, Math.atan2(mx, mz), dt * 12);
      player.walkPhase += dt * speed * 1.9;
      NV.walkCycle(player.mesh, player.walkPhase, sprint ? 1.3 : 1);
    } else {
      NV.walkCycle(player.mesh, 0, 0);
    }
    // A punch overrides the right arm's swing for its few frames.
    if (G.time < player.punchUntil) player.mesh.userData.armR.rotation.x = -2.0;
    NV.resolveCircle(p, 0.45, world.colliders);
    // Cars are solid to walk into.
    for (var i = 0; i < allCars.length; i++) {
      var c = allCars[i].pos();
      var d = NV.dist2(p.x, p.z, c.x, c.z);
      if (d < 2.0 && d > 1e-4) {
        p.x += (p.x - c.x) / d * (2.0 - d);
        p.z += (p.z - c.z) / d * (2.0 - d);
      }
    }
    var lim = NV.CITY.HALF - 1;
    p.x = NV.clamp(p.x, -lim, lim);
    p.z = NV.clamp(p.z, -lim, lim);
    player.mesh.rotation.y = player.heading;
  }

  function updatePlayerDriving(dt) {
    var car = player.car;
    var input = {
      throttle: (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0),
      steer: (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0),
      brake: !!keys.Space
    };
    var impact = NV.driveCar(car, dt, input, world.colliders);
    if (impact > 9) {
      NV.Sound.thud(NV.clamp(impact / 27, 0, 1));
      if (impact > 15) player.health -= (impact - 15) * 0.7;
    }
    NV.Sound.engine(true, Math.abs(car.speed) / 27, dt);
    G.camYaw = NV.angleLerp(G.camYaw, car.heading, dt * 4.2);
    G.driveYawOffset = NV.lerp(G.driveYawOffset, 0, dt * 0.8);
  }

  function updateCamera(dt) {
    if (G.state === 'title') {
      var a = G.time * 0.07;
      camera.position.set(Math.cos(a) * 120, 55, Math.sin(a) * 120);
      camera.lookAt(0, 0, 0);
      return;
    }
    var target, dist;
    if (player.mode === 'car' && player.car) {
      var cp = player.car.pos();
      target = { x: cp.x, y: 1.4, z: cp.z };
      dist = 10.5;
      var yaw = G.camYaw + G.driveYawOffset;
      var pitch = 0.3;
      camera.position.set(
        target.x - Math.sin(yaw) * Math.cos(pitch) * dist,
        target.y + Math.sin(pitch) * dist + 1.2,
        target.z - Math.cos(yaw) * Math.cos(pitch) * dist
      );
      camera.lookAt(target.x + Math.sin(yaw) * 6, target.y + 0.6, target.z + Math.cos(yaw) * 6);
    } else {
      var pp = player.mesh.position;
      target = { x: pp.x, y: 1.7, z: pp.z };
      dist = 7.6;
      camera.position.set(
        target.x - Math.sin(G.camYaw) * Math.cos(G.camPitch) * dist,
        target.y + Math.sin(G.camPitch) * dist,
        target.z - Math.cos(G.camYaw) * Math.cos(G.camPitch) * dist
      );
      if (camera.position.y < 0.6) camera.position.y = 0.6;
      camera.lookAt(
        target.x + Math.sin(G.camYaw) * 5, target.y + 0.4, target.z + Math.cos(G.camYaw) * 5
      );
    }
  }

  function updateWanted(dt) {
    var st = stars();
    var pt = playerPoint();
    // Decay: once crimes are a few seconds old and no officer is close, heat bleeds off.
    var nearestPolice = 1e9;
    for (var i = 0; i < NV.Police.cars.length; i++) {
      var pp = NV.Police.cars[i].pos();
      nearestPolice = Math.min(nearestPolice, NV.dist2(pp.x, pp.z, pt.x, pt.z));
    }
    if (G.time - G.wanted.lastCrime > 6 && nearestPolice > 55) {
      G.wanted.heat = Math.max(0, G.wanted.heat - dt * 0.11);
    } else if (G.time - G.wanted.lastCrime > 12) {
      G.wanted.heat = Math.max(0, G.wanted.heat - dt * 0.04);
    }
    if (st > 0 && stars() === 0) {
      clearPolice();
      toast('You lost the heat. The PPD gives up — for now.', 3);
    }
    // Keep the police presence matched to the star count.
    G.policeCooldown -= dt;
    if (stars() > NV.Police.cars.length && G.policeCooldown <= 0) {
      NV.Police.spawnOne(scene, world, pt);
      G.policeCooldown = 2.2;
    }
    // Siren volume follows the nearest unit.
    if (NV.Police.cars.length) {
      NV.Sound.siren(true, NV.clamp(1 - nearestPolice / 80, 0, 1) * 0.06);
    } else {
      NV.Sound.siren(false, 0);
    }
    // Busted: an officer on top of a player on foot for a couple of seconds ends it.
    if (player.mode === 'foot' && stars() > 0 && nearestPolice < 3.4) {
      player.bustTimer += dt;
      if (player.bustTimer > 2) {
        player.bustTimer = 0;
        respawn(world.policeStation, Math.min(player.money, 150), 'BUSTED');
      }
    } else {
      player.bustTimer = Math.max(0, player.bustTimer - dt * 2);
    }
  }

  function updateWorld(dt) {
    var pt = playerPoint();
    // Traffic obstacles: the player plus every car (each car ignores itself by geometry).
    var obstacles = [pt];
    for (var i = 0; i < allCars.length; i++) {
      var c = allCars[i].pos();
      obstacles.push({ x: c.x, z: c.z });
    }
    NV.Traffic.update(dt, world, obstacles);
    NV.Police.update(dt, world, pt, G.time);
    NV.Peds.update(dt, world);

    // Pedestrians versus moving cars: only fast cars knock anyone down.
    for (var ci = 0; ci < allCars.length; ci++) {
      var car = allCars[ci];
      if (Math.abs(car.speed) < 5.5) continue;
      for (var pi2 = 0; pi2 < NV.Peds.list.length; pi2++) {
        var ped = NV.Peds.list[pi2];
        var pp = ped.pos();
        if (NV.dist2(pp.x, pp.z, car.pos().x, car.pos().z) < 1.7) {
          if (ped.knockDown()) {
            NV.Sound.thud(0.7);
            if (car.driver === 'player') {
              commitCrime('hitPed', pp);
              toast('You ran someone down. The whole street saw it.', 3);
            }
          }
        }
      }
      // A speeding car also startles walkers it bears down on.
      if (Math.abs(car.speed) > 11) NV.Peds.startleNear(car.pos(), 9);
    }

    // Car-to-car contacts.
    NV.collideCars(allCars.concat(NV.Police.cars), function (a, b, rel) {
      var playerInvolved = a.driver === 'player' || b.driver === 'player';
      if (!playerInvolved) return;
      NV.Sound.thud(NV.clamp(rel / 16, 0.2, 1));
      var other = a.driver === 'player' ? b : a;
      commitCrime(other.police ? 'hitPolice' : 'hitCar', playerPoint());
      if (rel > 11) player.health -= (rel - 11) * 0.8;
    });

    // Police ramming the player.
    if (player.mode === 'car') {
      for (var ri = 0; ri < NV.Police.cars.length; ri++) {
        var pc = NV.Police.cars[ri];
        if (pc.ai.ramCooldown <= 0 &&
            NV.dist2(pc.pos().x, pc.pos().z, pt.x, pt.z) < 3.6 && Math.abs(pc.speed) > 5) {
          pc.ai.ramCooldown = 1.3;
          player.health -= 5;
          NV.Sound.thud(0.6);
        }
      }
    }
  }

  // --- Missions -----------------------------------------------------------------
  // Rosa Delgado's chain: two intro jobs, then a timed delivery, a hot pickup
  // and a repo job. startMission rebuilds a mission's props; completeMission
  // pays out, autosaves and advances. After the chain, the garage buys any
  // stolen car for scrap, forever.
  function missionTarget() {
    switch (G.mission) {
      case 0: case 1: case 5: return world.garage;
      case 2:
        if (G.md.stage === 'drive') return DROP_POINT;
        if (G.md.stage === 'ready' && deliveryCar) return deliveryCar.pos();
        return world.garage;
      case 3: return G.md.carrying ? world.garage : PACKAGE_POINT;
      case 4:
        if (player.car && player.car === repoCar) return world.garage;
        return repoCar ? repoCar.pos() : world.garage;
    }
    return world.garage;
  }

  function removeCar(car) {
    if (!car) return;
    scene.remove(car.mesh);
    var i = allCars.indexOf(car);
    if (i >= 0) allCars.splice(i, 1);
  }

  function startMission(idx) {
    G.md = {};
    if (idx === 2) {
      // Rosa's gold car waits on the apron; the clock starts when you take it.
      G.md.stage = 'ready';
      G.md.timer = 0;
      if (!deliveryCar) {
        deliveryCar = new NV.Car(scene, {
          x: world.garage.x - 13, z: world.garage.z + 7,
          heading: Math.PI / 2, color: 0xe0a51f, own: true
        });
        allCars.push(deliveryCar);
      }
    } else if (idx === 3) {
      G.md.carrying = false;
      packageMesh.visible = true;
    } else if (idx === 4) {
      G.md.stolenAt = 0;
      if (!repoCar) {
        repoCar = new NV.Car(scene, {
          x: REPO_SPOT.x, z: REPO_SPOT.z, heading: REPO_SPOT.heading, color: 0x744a9e
        });
        allCars.push(repoCar);
      }
      if (!owner) {
        owner = {
          mesh: NV.buildHumanoid(0xb03024, 0x222222, 0xc68863),
          active: true, aggro: false, punchCd: 0, downUntil: 0, phase: 0,
          home: { x: REPO_SPOT.x + 2.2, z: REPO_SPOT.z + 1.5 }
        };
        owner.mesh.position.set(owner.home.x, 0, owner.home.z);
        scene.add(owner.mesh);
      }
      owner.active = true;
      owner.aggro = false;
    }
    el.objective.textContent = OBJECTIVES[idx];
  }

  function completeMission(payout, line) {
    player.money += payout;
    NV.Sound.jingle();
    toast(line + ' +$' + payout, 4.5);
    G.mission++;
    startMission(G.mission);
    saveGame(false); // progress is banked the moment a job closes
  }

  function failDelivery(reason) {
    if (player.car === deliveryCar) exitCar();
    removeCar(deliveryCar);
    deliveryCar = null;
    G.md.stage = 'wait';
    G.md.timer = 0;
    toast(reason + ' Rosa: "Back to the garage. We run it again."', 4);
  }

  function updateMissions(dt) {
    var pt = playerPoint();
    var g = world.garage;
    var atGarage = NV.dist2(pt.x, pt.z, g.x, g.z) < g.r;
    if (G.mission === 0) {
      if (atGarage) {
        completeMission(250, 'Delgado: "You made it. Now bring me a car — any car."');
      }
    } else if (G.mission === 1) {
      if (atGarage && player.mode === 'car' && player.car && player.car.stolen) {
        player.car.stolen = false; // the delivered car is Delgado's now; driving it is legal
        completeMission(400, 'Delgado: "Clean work. Take the pistol by the door — you have earned it."');
      }
    } else if (G.mission === 2) {
      if (G.md.stage === 'wait') {
        if (atGarage) {
          startMission(2);
          toast('Rosa: "Gold car is fuelled. This time, beat the clock."', 3.5);
        }
      } else if (G.md.stage === 'ready') {
        if (player.car === deliveryCar) {
          G.md.stage = 'drive';
          G.md.timer = 120;
          toast('Rosa: "North-west corner, two minutes. Go!"', 3);
        }
      } else if (G.md.stage === 'drive') {
        G.md.timer -= dt;
        if (player.car === deliveryCar &&
            NV.dist2(pt.x, pt.z, DROP_POINT.x, DROP_POINT.z) < DROP_POINT.r) {
          deliveryCar.own = false; // delivered: it belongs to the buyer now
          completeMission(700, 'The buyer counts the cash without a word.');
        } else if (G.md.timer <= 0) {
          failDelivery('Out of time — the buyer walked away.');
        }
      }
    } else if (G.mission === 3) {
      if (!G.md.carrying) {
        if (player.mode === 'foot' &&
            NV.dist2(pt.x, pt.z, PACKAGE_POINT.x, PACKAGE_POINT.z) < 2.6) {
          G.md.carrying = true;
          packageMesh.visible = false;
          // The pickup is blown: three stars, right now.
          G.wanted.heat = Math.max(G.wanted.heat, 3.1);
          G.wanted.lastCrime = G.time;
          NV.Peds.startleNear(pt, 15);
          toast('Package in hand — and the whole block just called it in. Move!', 3.5);
        }
      } else if (atGarage) {
        packageMesh.visible = false;
        completeMission(800, 'Delgado: "Whatever that was, we never saw it."');
      }
    } else if (G.mission === 4) {
      if (repoCar && repoCar.stolen && !G.md.stolenAt) G.md.stolenAt = G.time;
      if (atGarage && player.mode === 'car' && player.car === repoCar) {
        var elapsed = G.md.stolenAt ? G.time - G.md.stolenAt : 999;
        var bonus = NV.clamp(Math.round(300 - elapsed * 2), 0, 300);
        repoCar.stolen = false;
        if (owner) owner.active = false;
        if (owner) owner.mesh.visible = false;
        completeMission(500 + bonus,
          'Delgado: "Repo complete." (time bonus +$' + bonus + ')');
      }
    } else if (G.mission === 5) {
      // Free roam loop: the garage fence buys any stolen car for scrap.
      if (atGarage && player.mode === 'car' && player.car && player.car.stolen) {
        player.car.stolen = false;
        player.money += 150;
        NV.Sound.jingle();
        toast('Scrap sale — +$150. Delgado strips it for parts.', 3);
      }
    }
  }

  // The repo car's owner: he minds his car, and he minds you taking it. He
  // chases on foot, punches when he reaches you, and gives up if you get far
  // away or the job ends. A punch or a bullet puts him down for a while.
  function updateOwner(dt) {
    if (!owner || !owner.active) return;
    var m = owner.mesh;
    if (G.time < owner.downUntil) return; // down; the tipped mesh says it all
    if (m.rotation.x !== 0) { m.rotation.x = 0; m.position.y = 0; }
    var p = m.position;
    var pt = playerPoint();
    var carPos = repoCar ? repoCar.pos() : owner.home;
    if (!owner.aggro) {
      var nearCar = NV.dist2(pt.x, pt.z, carPos.x, carPos.z) < 4.5;
      if ((repoCar && repoCar.driver === 'player') || nearCar) owner.aggro = true;
      else {
        // Idle: drift back to his spot beside the car.
        var hd = NV.dist2(p.x, p.z, owner.home.x, owner.home.z);
        if (hd > 0.4) {
          var ha = Math.atan2(owner.home.x - p.x, owner.home.z - p.z);
          m.rotation.y = NV.angleLerp(m.rotation.y, ha, dt * 6);
          p.x += Math.sin(m.rotation.y) * 1.4 * dt;
          p.z += Math.cos(m.rotation.y) * 1.4 * dt;
          owner.phase += dt * 4.8;
          NV.walkCycle(m, owner.phase, 1);
        } else NV.walkCycle(m, 0, 0);
        return;
      }
    }
    var d = NV.dist2(p.x, p.z, pt.x, pt.z);
    if (d > 60 || G.mission !== 4) { owner.aggro = false; return; }
    var desired = Math.atan2(pt.x - p.x, pt.z - p.z);
    m.rotation.y = NV.angleLerp(m.rotation.y, desired, dt * 8);
    if (d > 1.6) {
      p.x += Math.sin(m.rotation.y) * 6.1 * dt;
      p.z += Math.cos(m.rotation.y) * 6.1 * dt;
      NV.resolveCircle(p, 0.45, world.colliders);
      owner.phase += dt * 11;
      NV.walkCycle(m, owner.phase, 1.35);
    } else if (player.mode === 'foot') {
      owner.punchCd -= dt;
      NV.walkCycle(m, 0, 0);
      if (owner.punchCd <= 0) {
        owner.punchCd = 0.85;
        player.health -= 6;
        NV.Sound.thud(0.55);
        toast('The owner is laying into you — move or fight back!', 1.6);
        // Shove the player back a step.
        player.mesh.position.x += Math.sin(m.rotation.y) * 0.7;
        player.mesh.position.z += Math.cos(m.rotation.y) * 0.7;
      }
    }
  }

  // Objective dressing: the beacon sits on the mission target, the pistol pad
  // shows once it is earned, the flash dies, a finished reload lands.
  function updateMissionFx(dt) {
    var t = missionTarget();
    if (t && G.state === 'playing') {
      marker.visible = true;
      marker.position.set(t.x, 0, t.z);
      gem.rotation.y += dt * 2.4;
      gem.position.y = 3.4 + Math.sin(G.time * 2.2) * 0.35;
    } else {
      marker.visible = false;
    }
    pistolMesh.visible = G.mission >= 2;
    if (pistolMesh.visible) pistolMesh.rotation.y += dt * 1.2;
    if (flashMesh.visible && G.time > flashUntil) {
      flashMesh.visible = false;
      flashLight.intensity = 0;
    }
    if (player.reloadAt && G.time >= player.reloadAt) {
      var need = 12 - player.ammo;
      var take = Math.min(need, player.reserve);
      player.ammo += take;
      player.reserve -= take;
      player.reloadAt = 0;
    }
  }

  // --- HUD & minimap -------------------------------------------------------------
  function updateHUD() {
    el.healthFill.style.width = NV.clamp(player.health, 0, 100) + '%';
    el.healthFill.style.background = player.health > 30 ? '#59c24d' : '#d23b2e';
    el.money.textContent = '$' + Math.floor(player.money);
    var st = stars();
    var s = '';
    for (var i = 0; i < 5; i++) s += i < st ? '★' : '☆';
    el.stars.textContent = s;
    el.stars.style.opacity = st ? '1' : '0.25';
    el.wantedLabel.style.opacity = st ? '1' : '0';
    el.objective.textContent = OBJECTIVES[G.mission];
    el.speed.textContent = (player.mode === 'car' && player.car)
      ? Math.round(Math.abs(player.car.speed) * 3.6) + ' km/h' : '';
    // Weapon readout and crosshair, only while armed and on foot.
    var armed = player.hasPistol && player.mode === 'foot';
    el.weapon.textContent = !player.hasPistol ? '' :
      (player.reloadAt && G.time < player.reloadAt) ? 'PISTOL — reloading…' :
      'PISTOL ' + player.ammo + ' / ' + player.reserve;
    el.crosshair.style.display = (armed && G.state === 'playing') ? 'block' : 'none';
    // The delivery clock, while Rosa's gold car is running.
    if (G.mission === 2 && G.md.stage === 'drive') {
      var left = Math.max(0, Math.ceil(G.md.timer));
      el.timer.textContent = Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2);
      el.timer.style.color = left <= 20 ? '#ff7a6b' : '#ffd94d';
    } else {
      el.timer.textContent = '';
    }
    if (G.state === 'playing' && player.mode === 'foot') {
      el.prompt.textContent = nearPistol()
        ? (player.hasPistol ? 'E — refill pistol ammo' : 'E — take the pistol')
        : (nearestEnterableCar() ? 'E — enter car' : '');
    } else {
      el.prompt.textContent = (G.state === 'playing' && player.mode === 'car') ? 'E — exit car' : '';
    }
    if (G.time > G.toastUntil) el.toast.style.opacity = '0';
  }

  function drawMinimap() {
    var S = el.minimap.width, half = S / 2, scale = half / 120; // 120-unit view radius
    var pt = playerPoint();
    var X = function (wx) { return half + (wx - pt.x) * scale; };
    var Z = function (wz) { return half + (wz - pt.z) * scale; };
    mapCtx.fillStyle = '#20262c';
    mapCtx.fillRect(0, 0, S, S);
    // Blocks as faint pavement squares.
    mapCtx.fillStyle = '#39424b';
    for (var i = 0; i < NV.CITY.GRID; i++) {
      for (var j = 0; j < NV.CITY.GRID; j++) {
        var o = NV.blockOrigin(i, j);
        mapCtx.fillRect(X(o.x), Z(o.z), NV.CITY.BLOCK * scale, NV.CITY.BLOCK * scale);
      }
    }
    // Roads.
    mapCtx.fillStyle = '#59636e';
    for (var k = 0; k < NV.CITY.roadCenters.length; k++) {
      var c = NV.CITY.roadCenters[k];
      mapCtx.fillRect(X(c - NV.CITY.ROAD / 2), 0, NV.CITY.ROAD * scale, S);
      mapCtx.fillRect(0, Z(c - NV.CITY.ROAD / 2), S, NV.CITY.ROAD * scale);
    }
    // Mission marker: the gold dot sits on whatever the objective points at.
    var mt = missionTarget();
    if (mt) {
      mapCtx.fillStyle = '#ffd94d';
      mapCtx.beginPath();
      mapCtx.arc(X(mt.x), Z(mt.z), 5, 0, Math.PI * 2);
      mapCtx.fill();
    }
    // Traffic.
    mapCtx.fillStyle = '#c8ccd2';
    trafficCars.forEach(function (car) {
      mapCtx.fillRect(X(car.pos().x) - 2, Z(car.pos().z) - 2, 4, 4);
    });
    // Police blips blink.
    if (Math.floor(G.time * 2.4) % 2 === 0) {
      mapCtx.fillStyle = '#ff4040';
      NV.Police.cars.forEach(function (car) {
        mapCtx.beginPath();
        mapCtx.arc(X(car.pos().x), Z(car.pos().z), 3.4, 0, Math.PI * 2);
        mapCtx.fill();
      });
    }
    // Player arrow.
    var heading = player.mode === 'car' && player.car ? player.car.heading : player.heading;
    mapCtx.save();
    mapCtx.translate(half, half);
    mapCtx.rotate(headingToMapAngle(heading));
    mapCtx.fillStyle = '#ffffff';
    mapCtx.beginPath();
    mapCtx.moveTo(0, -7);
    mapCtx.lineTo(4.6, 5);
    mapCtx.lineTo(0, 2.4);
    mapCtx.lineTo(-4.6, 5);
    mapCtx.closePath();
    mapCtx.fill();
    mapCtx.restore();
  }
  // World heading: 0 faces +Z (south on the map, +y down). Canvas rotation is
  // clockwise for positive angles with y down, and a drawn arrow points up (-y),
  // so the map rotation for a heading is PI - heading... verified by the four
  // cardinal points: heading 0 (south) must point down: rotate(PI). Heading
  // PI/2 (east, +X) must point right: rotate(PI/2). PI - PI/2 = PI/2. Correct.
  function headingToMapAngle(heading) { return Math.PI - heading; }

  // --- Main loop --------------------------------------------------------------------
  // Fixed-timestep simulation: the world steps at 120 Hz from an accumulator,
  // however fast frames actually arrive, so the game runs at the same speed at
  // 10 fps as at 144 fps. (The old per-frame dt clamp turned low frame rates
  // into slow motion.) Frame debt is capped at one second: past that the game
  // sheds time instead of spiralling. A second of simulation costs a small
  // fraction of a second of CPU, so the cap only bites when rendering itself
  // runs under 1 fps. Rendering always draws the latest state.
  var STEP = 1 / 120, MAX_STEPS = 120;
  var acc = 0, lastStamp = -1;

  function stepGame(dt) {
    if (G.state === 'playing') {
      G.time += dt;
      if (player.mode === 'car') updatePlayerDriving(dt);
      else { updatePlayerOnFoot(dt); NV.Sound.engine(false, 0, dt); }
      updateWorld(dt);
      updateWanted(dt);
      updateMissions(dt);
      updateOwner(dt);
      updateMissionFx(dt);
      if (player.health <= 0) respawn(world.hospital, Math.min(player.money, 100), 'WASTED');
    } else if (G.state === 'title') {
      G.time += dt;
      // The city lives behind the title screen.
      NV.Traffic.update(dt, world, []);
      NV.Peds.update(dt, world);
    }
    updateCamera(dt);
  }

  function frame(stamp) {
    requestAnimationFrame(frame);
    if (lastStamp < 0) lastStamp = stamp;
    acc += Math.min((stamp - lastStamp) / 1000, 1.0);
    lastStamp = stamp;
    var steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) {
      stepGame(STEP);
      acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) acc = 0; // shed the debt rather than spiral
    if (G.state === 'playing') { updateHUD(); drawMinimap(); }
    renderer.render(scene, camera);
  }
  // --- Screenshot / automated-test hook -------------------------------------
  // Headless browsers cannot hold pointer lock, so the title screen's click
  // flow cannot start a test run. With ?autostart=1 (or a ?shot scene other
  // than "start") the game starts directly, without pointer lock; keyboard
  // input works as usual and the camera keeps its default follow position.
  // ?shot=<scene> stages the scenes named in shots.json: start (the title
  // orbit, untouched), play (on foot at spawn), drive (in your car on the
  // z=111 road, throttle held by the script) and chase (the same drive with
  // a 3-star wanted level, so the police response is real gameplay).
  var shotScene = params.get('shot');
  if (params.has('autostart') || (shotScene && shotScene !== 'start')) {
    NV.Sound.init();
    el.startScreen.style.display = 'none';
    el.hud.style.display = 'block';
    G.state = 'playing';
    if (shotScene === 'drive' || shotScene === 'chase') {
      ownCar.mesh.position.set(-150, 0, 108.7); // eastbound lane of the z=111 road, city on both sides
      ownCar.heading = Math.PI / 2;
      ownCar.syncMesh();
      ownCar.driver = 'player';
      player.car = ownCar;
      player.mode = 'car';
      player.mesh.visible = false;
      G.camYaw = ownCar.heading;
      keys.KeyW = true; // scripted throttle: the car drives itself east
      if (shotScene === 'chase') {
        G.wanted.heat = 3;
        G.wanted.lastCrime = 0;
      }
    }
  }

  // ?debug=1 exposes the live state so automated tests can verify systems
  // (missions, saves, combat) that the HUD alone cannot show. Normal play
  // passes no such param and gets no handle.
  if (params.has('debug')) {
    window.__pn = {
      G: G, player: player, world: world, allCars: allCars, peds: NV.Peds,
      deliveryCar: function () { return deliveryCar; },
      repoCar: function () { return repoCar; },
      owner: function () { return owner; },
      saveGame: saveGame, applySave: applySave
    };
  }

  el.objective.textContent = OBJECTIVES[0];
  requestAnimationFrame(frame);
})();
