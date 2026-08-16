// ─── Wanderguild — one-thumb MMO-lite prototype ──────────────────
// Single-player client build. Everything under "SIM PLAYERS" fakes the
// multiplayer layer (zone presence, chat, boss convergence) locally;
// that module is the seam where a real backend (Nakama / Firebase)
// plugs in later without touching game logic.

(function () {
  'use strict';

  // ─── Canvas / camera ───────────────────────────────────────────
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let VW = 0, VH = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    VW = window.innerWidth; VH = window.innerHeight;
    canvas.width = VW * DPR; canvas.height = VH * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  const WORLD = { w: 2400, h: 2400 };
  const CAMP  = { x: 1200, y: 1650 };
  const ARENA = { x: 1200, y: 520 };
  const cam = { x: CAMP.x, y: CAMP.y };

  // ─── Utils ─────────────────────────────────────────────────────
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[(Math.random() * arr.length) | 0];

  // Seeded RNG so world decoration is stable between sessions
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ─── Persistence ───────────────────────────────────────────────
  const SAVE_KEY = 'wanderguild_save_v1';
  function loadSave() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || null; }
    catch (e) { return null; }
  }
  function persist() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        cls: player.cls, lvl: player.lvl, xp: player.xp, gold: player.gold,
        gear: player.gear, campLvl: camp.lvl,
      }));
    } catch (e) { /* storage unavailable — play on without saves */ }
  }

  // ─── Classes ───────────────────────────────────────────────────
  const CLASSES = {
    knight: { emoji: '🛡️', name: 'Knight', hp: 130, dmgMul: 1.0, range: 48,  atkCd: 0.7,  speed: 150, projectile: null,
              ability: { icon: '⚔️', name: 'Whirlwind',   cd: 8 } },
    ranger: { emoji: '🏹', name: 'Ranger', hp: 100, dmgMul: 0.8, range: 220, atkCd: 0.55, speed: 165, projectile: { speed: 440, emoji: '➳', size: 12 },
              ability: { icon: '🌠', name: 'Arrow Volley', cd: 8 } },
    mage:   { emoji: '🔮', name: 'Mage',   hp: 90,  dmgMul: 1.5, range: 200, atkCd: 1.1,  speed: 145, projectile: { speed: 300, emoji: '✦', size: 14, splash: 46 },
              ability: { icon: '🔥', name: 'Ember Nova',   cd: 8 } },
  };

  // ─── Game state ────────────────────────────────────────────────
  const player = {
    x: CAMP.x, y: CAMP.y + 40, r: 15,
    cls: null, lvl: 1, xp: 0, gold: 0,
    hp: 100, maxHp: 100,
    target: null,          // tap-to-move destination
    atkTimer: 0, abilityTimer: 0,
    dead: false, deadTimer: 0,
    gear: { weapon: null, armor: null, charm: null },
    burnTargets: [],       // mage dot bookkeeping
    facing: 1,
  };
  const camp = { lvl: 1 };
  const mobs = [], projectiles = [], floaters = [], particles = [], telegraphs = [];
  let tapMarker = null;
  let boss = null;
  let bossTimer = 45;      // first boss shows up quickly so the loop is visible
  const BOSS_INTERVAL = 150;
  let gameTime = 0;

  function xpNeed(lvl) { return Math.round(25 * Math.pow(lvl, 1.35) + 15); }
  function baseDmg()  { return (6 + player.lvl * 2) * CLASSES[player.cls].dmgMul; }
  function weaponPow(){ return player.gear.weapon ? player.gear.weapon.power : 0; }
  function armorPow() { return player.gear.armor  ? player.gear.armor.power  : 0; }
  function playerDmg(){ return Math.round(baseDmg() + weaponPow()); }
  function playerMaxHp() {
    const c = CLASSES[player.cls];
    return c.hp + (player.lvl - 1) * 12 + (player.gear.charm ? player.gear.charm.power * 3 : 0);
  }

  // ─── HUD refs ──────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const hpFill = $('hpFill'), xpFill = $('xpFill'), lvlTag = $('lvlTag'),
        goldPlate = $('goldPlate'), heroName = $('heroName'),
        abilityBtn = $('abilityBtn'), abilityIcon = $('abilityIcon'), cdNum = $('cdNum'),
        donateBtn = $('donateBtn'), feed = $('feed'),
        bossBanner = $('bossBanner'), bossBar = $('bossBar'), bossFill = $('bossFill'),
        classOverlay = $('classOverlay'), deathOverlay = $('deathOverlay');

  function addFeed(html, cls) {
    const line = document.createElement('div');
    line.className = 'feed-line' + (cls ? ' ' + cls : '');
    line.innerHTML = html;
    feed.insertBefore(line, feed.firstChild);
    while (feed.children.length > 8) feed.removeChild(feed.lastChild);
    setTimeout(() => { if (line.parentNode) { line.style.opacity = '0'; line.style.transition = 'opacity 1s'; } }, 11000);
    setTimeout(() => { if (line.parentNode) line.parentNode.removeChild(line); }, 12200);
  }

  // ─── World decoration (seeded, stable) ─────────────────────────
  const deco = [];
  {
    const rng = mulberry32(1337);
    const KINDS = [
      { e: '🌲', s: 34, n: 60 }, { e: '🌳', s: 32, n: 40 }, { e: '🪨', s: 20, n: 30 },
      { e: '🌾', s: 16, n: 60 }, { e: '🌼', s: 13, n: 50 }, { e: '🍄', s: 14, n: 20 },
    ];
    for (const k of KINDS) {
      for (let i = 0; i < k.n; i++) {
        const x = 60 + rng() * (WORLD.w - 120), y = 60 + rng() * (WORLD.h - 120);
        if (Math.hypot(x - CAMP.x, y - CAMP.y) < 240) continue;   // keep camp clear
        if (Math.hypot(x - ARENA.x, y - ARENA.y) < 260) continue; // keep arena clear
        deco.push({ x, y, e: k.e, s: k.s });
      }
    }
    deco.sort((a, b) => a.y - b.y);
  }

  // ─── Mobs ──────────────────────────────────────────────────────
  const MOB_TYPES = [
    { id: 'snail',   name: 'Meadow Snail', emoji: '🐌', hp: 26,  dmg: 4,  xp: 9,  gold: [1, 3],  speed: 32,  r: 13, aggro: 90,  tier: 1 },
    { id: 'boar',    name: 'Bristleboar',  emoji: '🐗', hp: 55,  dmg: 8,  xp: 18, gold: [2, 6],  speed: 78,  r: 15, aggro: 130, tier: 2 },
    { id: 'wolf',    name: 'Vale Wolf',    emoji: '🐺', hp: 85,  dmg: 12, xp: 30, gold: [4, 9],  speed: 105, r: 15, aggro: 170, tier: 3 },
    { id: 'brigand', name: 'Brigand',      emoji: '🥷', hp: 130, dmg: 17, xp: 48, gold: [8, 16], speed: 95,  r: 15, aggro: 190, tier: 4 },
  ];
  // Spawn bands: farther from camp = meaner mobs
  function tierAt(x, y) {
    const d = Math.hypot(x - CAMP.x, y - CAMP.y);
    if (d < 420) return 1;
    if (d < 750) return 2;
    if (d < 1050) return 3;
    return 4;
  }
  function spawnMob() {
    for (let tries = 0; tries < 20; tries++) {
      const x = rand(80, WORLD.w - 80), y = rand(80, WORLD.h - 80);
      if (Math.hypot(x - CAMP.x, y - CAMP.y) < 300) continue;
      if (Math.hypot(x - ARENA.x, y - ARENA.y) < 240) continue;
      const t = MOB_TYPES[clamp(tierAt(x, y) - 1 + ((Math.random() < 0.25) ? 1 : 0), 0, 3)];
      mobs.push({
        type: t, x, y, hx: x, hy: y, hp: t.hp, maxHp: t.hp,
        state: 'idle', wanderT: rand(0, 3), atkT: 0, hitFlash: 0, burn: 0,
      });
      return;
    }
  }
  for (let i = 0; i < 46; i++) spawnMob();

  // ─── Loot ──────────────────────────────────────────────────────
  const RARITIES = [
    { id: 'common', name: 'Common', chance: 0.62, mul: 1.0, color: '#cbd5e1' },
    { id: 'fine',   name: 'Fine',   chance: 0.25, mul: 1.5, color: '#4ade80' },
    { id: 'rare',   name: 'Rare',   chance: 0.10, mul: 2.2, color: '#60a5fa' },
    { id: 'epic',   name: 'Epic',   chance: 0.03, mul: 3.2, color: '#c084fc' },
  ];
  const GEAR_BASES = {
    weapon: ['Blade', 'Longbow', 'Sparkrod', 'Cleaver', 'Warpick'],
    armor:  ['Jerkin', 'Chainshirt', 'Wandercloak', 'Plate'],
    charm:  ['Ember Charm', 'Moss Token', 'Owl Feather', 'Lucky Coin'],
  };
  function rollRarity(bonus) {
    let r = Math.random() - (bonus || 0);
    for (const rar of RARITIES) { r -= rar.chance; if (r <= 0) return rar; }
    return RARITIES[RARITIES.length - 1];
  }
  function rollGear(tier, forceEpic) {
    const slot = pick(['weapon', 'armor', 'charm']);
    const rar = forceEpic ? RARITIES[3] : rollRarity(tier * 0.02);
    const power = Math.max(1, Math.round((tier * 3 + rand(1, 4)) * rar.mul));
    return { slot, rarity: rar.id, name: `${rar.name} ${pick(GEAR_BASES[slot])}`, power };
  }
  function awardGear(item) {
    const cur = player.gear[item.slot];
    const rar = RARITIES.find(r => r.id === item.rarity);
    if (!cur || item.power > cur.power) {
      player.gear[item.slot] = item;
      player.maxHp = playerMaxHp();
      addFeed(`Equipped <span style="color:${rar.color}">${item.name}</span> (+${item.power} ${item.slot === 'armor' ? 'armor' : item.slot === 'charm' ? 'vigor' : 'attack'})`, 'loot');
    } else {
      const scrap = Math.ceil(item.power * 1.5);
      player.gold += scrap;
      addFeed(`Scrapped <span style="color:${rar.color}">${item.name}</span> for ${scrap}🪙`, 'loot');
    }
    persist();
  }

  // ─── Floaters / particles ──────────────────────────────────────
  function floatText(x, y, text, color, size) {
    floaters.push({ x, y, text, color: color || '#fff', size: size || 13, t: 0 });
  }
  function burst(x, y, color, n) {
    for (let i = 0; i < (n || 6); i++) {
      const a = Math.random() * Math.PI * 2, s = rand(30, 110);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0, life: rand(0.3, 0.6), color });
    }
  }

  // ─── Combat ────────────────────────────────────────────────────
  function nearestMob(x, y, maxD) {
    let best = null, bd = maxD;
    for (const m of mobs) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bd) { bd = d; best = m; }
    }
    if (boss && Math.hypot(boss.x - x, boss.y - y) < bd) best = boss;
    return best;
  }

  function hitTarget(t, dmg, fromPlayer) {
    t.hp -= dmg; t.hitFlash = 0.12;
    floatText(t.x + rand(-8, 8), t.y - 24, String(Math.round(dmg)), fromPlayer ? '#fde68a' : '#fca5a5', 13);
    if (t.hp <= 0) {
      if (t === boss) { killBoss(fromPlayer); return; }
      const idx = mobs.indexOf(t);
      if (idx >= 0) mobs.splice(idx, 1);
      burst(t.x, t.y, '#94a3b8', 8);
      if (fromPlayer) {
        const g = Math.round(rand(t.type.gold[0], t.type.gold[1]));
        player.gold += g; gainXp(t.type.xp);
        floatText(t.x, t.y - 10, `+${g}🪙`, '#fbbf24', 12);
        if (Math.random() < 0.16) awardGear(rollGear(t.type.tier, false));
      }
      setTimeout(spawnMob, rand(4000, 9000)); // keep the vale populated
    }
  }

  function gainXp(xp) {
    player.xp += xp;
    floatText(player.x, player.y - 34, `+${xp}xp`, '#c4b5fd', 11);
    while (player.xp >= xpNeed(player.lvl)) {
      player.xp -= xpNeed(player.lvl);
      player.lvl++;
      player.maxHp = playerMaxHp();
      player.hp = player.maxHp;
      burst(player.x, player.y, '#fbbf24', 16);
      floatText(player.x, player.y - 48, `LEVEL ${player.lvl}!`, '#fbbf24', 18);
      addFeed(`You reached level <b>${player.lvl}</b>!`, 'sys');
    }
    persist();
  }

  function fireProjectile(from, to, dmg, opts) {
    const d = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
    projectiles.push({
      x: from.x, y: from.y - 10,
      vx: (to.x - from.x) / d * opts.speed, vy: (to.y - from.y - 10) / d * opts.speed,
      dmg, emoji: opts.emoji, size: opts.size, splash: opts.splash || 0,
      pierce: opts.pierce || 0, t: 0, life: 1.4,
    });
  }

  function tryAutoAttack(dt) {
    player.atkTimer -= dt;
    if (player.atkTimer > 0) return;
    const c = CLASSES[player.cls];
    const t = nearestMob(player.x, player.y, c.range);
    if (!t) return;
    player.atkTimer = c.atkCd;
    player.facing = t.x >= player.x ? 1 : -1;
    if (c.projectile) {
      fireProjectile(player, t, playerDmg(), c.projectile);
    } else {
      hitTarget(t, playerDmg(), true);
      burst(t.x, t.y, '#fde68a', 4);
    }
  }

  function castAbility() {
    if (player.dead || !player.cls || player.abilityTimer > 0) return;
    const c = CLASSES[player.cls];
    player.abilityTimer = c.ability.cd;
    const dmg = playerDmg();
    if (player.cls === 'knight') {
      burst(player.x, player.y, '#fbbf24', 20);
      const targets = mobs.filter(m => dist(m, player) < 125).concat(boss && dist(boss, player) < 160 ? [boss] : []);
      for (const t of targets) hitTarget(t, dmg * 3, true);
      floatText(player.x, player.y - 40, 'WHIRLWIND!', '#fbbf24', 15);
    } else if (player.cls === 'ranger') {
      const aim = nearestMob(player.x, player.y, 600) || { x: player.x + player.facing * 100, y: player.y };
      const base = Math.atan2(aim.y - player.y, aim.x - player.x);
      for (let i = -3; i <= 3; i++) {
        const a = base + i * 0.13;
        fireProjectile(player, { x: player.x + Math.cos(a) * 100, y: player.y + Math.sin(a) * 100 + 10 },
          dmg * 1.2, { ...CLASSES.ranger.projectile, pierce: 2 });
      }
      floatText(player.x, player.y - 40, 'VOLLEY!', '#7dd3fc', 15);
    } else if (player.cls === 'mage') {
      burst(player.x, player.y, '#fb923c', 26);
      const targets = mobs.filter(m => dist(m, player) < 165).concat(boss && dist(boss, player) < 200 ? [boss] : []);
      for (const t of targets) { hitTarget(t, dmg * 3, true); t.burn = 3; }
      floatText(player.x, player.y - 40, 'EMBER NOVA!', '#fb923c', 15);
    }
  }
  abilityBtn.addEventListener('pointerdown', e => { e.preventDefault(); castAbility(); });

  // ─── World boss ────────────────────────────────────────────────
  function spawnBoss() {
    boss = {
      isBoss: true, x: ARENA.x, y: ARENA.y, r: 40,
      hp: 1400 + player.lvl * 160, maxHp: 1400 + player.lvl * 160,
      atkT: 4, hitFlash: 0, burn: 0, playerTouched: false,
    };
    bossBar.style.display = 'block';
    announce('⚔️ Bramblehorn has emerged in the northern vale!');
    Sim.onBossSpawn();
  }
  function killBoss(fromPlayer) {
    burst(boss.x, boss.y, '#f87171', 40);
    const participated = boss.playerTouched;
    boss = null;
    bossBar.style.display = 'none';
    telegraphs.length = 0;
    bossTimer = BOSS_INTERVAL;
    announce('🏆 Bramblehorn has been slain by the guild!');
    Sim.onBossDown();
    if (participated) {
      const g = 120 + player.lvl * 10;
      player.gold += g;
      gainXp(90 + player.lvl * 12);
      addFeed(`Boss reward: <b>${g}🪙</b> and a chest!`, 'sys');
      awardGear(rollGear(4, true));
    }
  }
  function announce(msg) {
    bossBanner.textContent = msg;
    bossBanner.style.opacity = '1';
    addFeed(msg, 'sys');
    setTimeout(() => { bossBanner.style.opacity = '0'; }, 4200);
  }
  function updateBoss(dt) {
    if (!boss) {
      bossTimer -= dt;
      if (bossTimer < 12 && bossTimer + dt >= 12) announce('🐗 Bramblehorn stirs in the northern vale…');
      if (bossTimer <= 0) spawnBoss();
      return;
    }
    boss.hitFlash = Math.max(0, boss.hitFlash - dt);
    if (boss.burn > 0) { boss.burn -= dt; boss.hp -= 8 * dt; if (boss.hp <= 0) { killBoss(true); return; } }
    bossFill.style.width = clamp(boss.hp / boss.maxHp * 100, 0, 100) + '%';
    // Slam telegraphs on whoever is in the arena (player or sim)
    boss.atkT -= dt;
    if (boss.atkT <= 0) {
      boss.atkT = 3.5;
      const near = dist(player, boss) < 420;
      const tx = near ? player.x + rand(-30, 30) : boss.x + rand(-160, 160);
      const ty = near ? player.y + rand(-30, 30) : boss.y + rand(-120, 160);
      telegraphs.push({ x: tx, y: ty, r: 84, t: 0, warn: 1.2 });
    }
    for (let i = telegraphs.length - 1; i >= 0; i--) {
      const tg = telegraphs[i];
      tg.t += dt;
      if (tg.t >= tg.warn) {
        burst(tg.x, tg.y, '#f87171', 14);
        if (!player.dead && Math.hypot(player.x - tg.x, player.y - tg.y) < tg.r) damagePlayer(26 + player.lvl * 2);
        telegraphs.splice(i, 1);
      }
    }
  }

  // ─── Player damage / death ─────────────────────────────────────
  function damagePlayer(raw) {
    if (player.dead) return;
    const dmg = raw * (100 / (100 + armorPow() * 4));
    player.hp -= dmg;
    floatText(player.x + rand(-6, 6), player.y - 28, String(Math.round(dmg)), '#fca5a5', 13);
    if (player.hp <= 0) {
      player.hp = 0; player.dead = true; player.deadTimer = 2;
      player.target = null;
      deathOverlay.style.display = 'flex';
      addFeed('You fell in battle. The guild carries you home.', 'sys');
    }
  }

  // ─── Mob update ────────────────────────────────────────────────
  function updateMobs(dt) {
    for (let i = mobs.length - 1; i >= 0; i--) {
      const m = mobs[i];
      m.hitFlash = Math.max(0, m.hitFlash - dt);
      if (m.burn > 0) { m.burn -= dt; m.hp -= 6 * dt; if (m.hp <= 0) { hitTarget(m, 0.1, true); continue; } }
      const dHome = Math.hypot(m.x - m.hx, m.y - m.hy);
      const dP = player.dead ? 1e9 : dist(m, player);

      if (m.state !== 'return' && dP < m.type.aggro && dHome < 420) m.state = 'chase';
      if (m.state === 'chase' && (dHome > 460 || player.dead)) { m.state = 'return'; }

      if (m.state === 'chase') {
        const stop = m.type.r + player.r + 2;
        if (dP > stop) moveToward(m, player, m.type.speed, dt);
        m.atkT -= dt;
        if (dP < stop + 6 && m.atkT <= 0) { m.atkT = 1.0; damagePlayer(m.type.dmg); }
      } else if (m.state === 'return') {
        moveToward(m, { x: m.hx, y: m.hy }, m.type.speed * 1.2, dt);
        m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.5 * dt);
        if (dHome < 8) { m.state = 'idle'; m.hp = m.maxHp; }
      } else {
        m.wanderT -= dt;
        if (m.wanderT <= 0) {
          m.wanderT = rand(2, 5);
          m.wx = m.hx + rand(-70, 70); m.wy = m.hy + rand(-70, 70);
        }
        if (m.wx !== undefined) moveToward(m, { x: m.wx, y: m.wy }, m.type.speed * 0.5, dt);
      }
    }
  }
  function moveToward(e, t, speed, dt) {
    const d = Math.hypot(t.x - e.x, t.y - e.y);
    if (d < 2) return;
    e.x += (t.x - e.x) / d * speed * dt;
    e.y += (t.y - e.y) / d * speed * dt;
    e.x = clamp(e.x, 20, WORLD.w - 20);
    e.y = clamp(e.y, 20, WORLD.h - 20);
  }

  // ─── SIM PLAYERS ───────────────────────────────────────────────
  // Fake zone population. In the real build this whole object is
  // replaced by a presence/state-sync client (Nakama match or
  // Firebase RTDB); render + feed code consumes the same shape.
  const Sim = (function () {
    const NAMES = ['Marrow', 'Fenwick', 'Bryony', 'Ashvale', 'Tumble', 'Quill', 'Nyra', 'Oakhart', 'Petra', 'Sooty', 'Wrenna'];
    const GUILDS = [
      { tag: 'WNDR', color: '#7dd3fc' }, { tag: 'MOSS', color: '#4ade80' }, { tag: 'OWL', color: '#c084fc' },
    ];
    const EMOJI = ['🧝', '🧙', '🧑‍🌾', '🥸', '🧛', '🤺', '🧜', '🫅'];
    const CHAT = [
      'anyone selling Fine Longbow?', 'wolves by the west ridge are juicy xp', 'gg', 'lol',
      'camp donations go brrr', 'who took my mushroom spot 😤', 'first boss of the day o7',
      'brb tea', 'this vale never gets old', 'need 2 more for brigand farm', 'nice drop!',
    ];
    const bots = [];
    for (let i = 0; i < 9; i++) {
      const g = pick(GUILDS);
      bots.push({
        name: NAMES[i], guild: g, emoji: pick(EMOJI),
        x: CAMP.x + rand(-500, 500), y: CAMP.y + rand(-700, 300),
        state: 'wander', wx: 0, wy: 0, wanderT: rand(0, 2), atkT: 0,
        chatT: rand(15, 80), speed: rand(120, 160), target: null, facing: 1,
      });
    }

    function update(dt) {
      for (const b of bots) {
        b.chatT -= dt;
        if (b.chatT <= 0) {
          b.chatT = rand(30, 120);
          addFeed(`<span class="who" style="color:${b.guild.color}">[${b.guild.tag}] ${b.name}:</span> ${pick(CHAT)}`);
        }
        if (b.state === 'boss' && boss) {
          const d = dist(b, boss);
          if (d > 120) moveToward(b, boss, b.speed, dt);
          else {
            b.atkT -= dt;
            if (b.atkT <= 0) { b.atkT = rand(0.6, 1.1); hitTarget(boss, rand(6, 14), false); }
          }
          b.facing = boss.x >= b.x ? 1 : -1;
          continue;
        }
        if (b.state === 'boss' && !boss) b.state = 'wander';

        if (b.state === 'hunt') {
          if (!b.target || b.target.hp <= 0 || mobs.indexOf(b.target) < 0) { b.target = null; b.state = 'wander'; }
          else {
            const d = dist(b, b.target);
            b.facing = b.target.x >= b.x ? 1 : -1;
            if (d > b.target.type.r + 22) moveToward(b, b.target, b.speed, dt);
            else {
              b.atkT -= dt;
              if (b.atkT <= 0) { b.atkT = rand(0.6, 1.0); hitTarget(b.target, rand(5, 12), false); }
            }
          }
        } else {
          b.wanderT -= dt;
          if (b.wanderT <= 0) {
            b.wanderT = rand(3, 7);
            if (Math.random() < 0.55) {
              // go pick a fight with something nearby
              let best = null, bd = 500;
              for (const m of mobs) { const d = dist(b, m); if (d < bd) { bd = d; best = m; } }
              if (best) { b.target = best; b.state = 'hunt'; continue; }
            }
            b.wx = clamp(b.x + rand(-260, 260), 60, WORLD.w - 60);
            b.wy = clamp(b.y + rand(-260, 260), 60, WORLD.h - 60);
          }
          if (b.wx) { b.facing = b.wx >= b.x ? 1 : -1; moveToward(b, { x: b.wx, y: b.wy }, b.speed * 0.7, dt); }
        }
      }
    }
    function onBossSpawn() {
      for (const b of bots) if (Math.random() < 0.8) b.state = 'boss';
      setTimeout(() => addFeed(`<span class="who">[WNDR] ${NAMES[0]}:</span> BOSS UP — everyone to the arena!`), 900);
    }
    function onBossDown() {
      for (const b of bots) b.state = 'wander';
      setTimeout(() => addFeed(`<span class="who">[MOSS] ${NAMES[2]}:</span> ${pick(['ez', 'gg all', 'o7 guild', 'loot me pls'])}`), 1200);
    }
    function onCampUpgrade(lvl) {
      setTimeout(() => addFeed(`<span class="who">[OWL] ${NAMES[5]}:</span> camp lvl ${lvl}! cozy 🔥`), 800);
    }
    return { bots, update, onBossSpawn, onBossDown, onCampUpgrade };
  })();

  // ─── Guild camp ────────────────────────────────────────────────
  function campCost() { return camp.lvl * 100; }
  donateBtn.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (player.gold < campCost()) return;
    player.gold -= campCost();
    camp.lvl++;
    burst(CAMP.x, CAMP.y, '#34d399', 24);
    addFeed(`⛺ Guild camp upgraded to level <b>${camp.lvl}</b>! (+regen)`, 'sys');
    Sim.onCampUpgrade(camp.lvl);
    persist();
  });

  // ─── Input: tap / drag to move ─────────────────────────────────
  let pointerDown = false;
  function toWorld(e) {
    return { x: e.clientX - VW / 2 + cam.x, y: e.clientY - VH / 2 + cam.y };
  }
  canvas.addEventListener('pointerdown', e => {
    if (player.dead || !player.cls) return;
    pointerDown = true;
    const w = toWorld(e);
    player.target = w;
    tapMarker = { x: w.x, y: w.y, t: 0 };
  });
  canvas.addEventListener('pointermove', e => {
    if (!pointerDown || player.dead || !player.cls) return;
    player.target = toWorld(e); // drag to steer
  });
  window.addEventListener('pointerup', () => { pointerDown = false; });
  window.addEventListener('pointercancel', () => { pointerDown = false; });

  // ─── Class select / boot ───────────────────────────────────────
  function startGame(cls) {
    player.cls = cls;
    const c = CLASSES[cls];
    player.maxHp = playerMaxHp();
    player.hp = Math.min(player.hp || 1e9, player.maxHp);
    if (player.hp <= 0 || !player.hp) player.hp = player.maxHp;
    heroName.textContent = `[WNDR] ${c.name}`;
    abilityIcon.textContent = c.ability.icon;
    classOverlay.style.display = 'none';
    addFeed(`You arrive in <b>Emberlea Vale</b>. ${Sim.bots.length + 1} wanderers online.`, 'sys');
    addFeed(`Tap anywhere to move. ${c.ability.name} is on the big button.`, 'sys');
    persist();
  }
  classOverlay.querySelectorAll('.class-card').forEach(btn => {
    btn.addEventListener('click', () => startGame(btn.dataset.class));
  });
  {
    const save = loadSave();
    if (save && save.cls && CLASSES[save.cls]) {
      player.lvl = save.lvl || 1; player.xp = save.xp || 0; player.gold = save.gold || 0;
      player.gear = Object.assign({ weapon: null, armor: null, charm: null }, save.gear);
      camp.lvl = save.campLvl || 1;
      startGame(save.cls);
      addFeed('Welcome back, wanderer.', 'sys');
    }
  }

  // ─── Update ────────────────────────────────────────────────────
  function update(dt) {
    if (!player.cls) return;
    gameTime += dt;

    if (player.dead) {
      player.deadTimer -= dt;
      if (player.deadTimer <= 0) {
        player.dead = false;
        player.x = CAMP.x; player.y = CAMP.y + 40;
        player.hp = player.maxHp;
        deathOverlay.style.display = 'none';
        for (const m of mobs) if (m.state === 'chase') m.state = 'return';
      }
    } else {
      // movement
      if (player.target) {
        const d = dist(player, player.target);
        if (d < 5) player.target = null;
        else {
          player.facing = player.target.x >= player.x ? 1 : -1;
          moveToward(player, player.target, CLASSES[player.cls].speed, dt);
        }
      } else {
        // idle: drift toward anything already in aggro on us
        const threat = mobs.find(m => m.state === 'chase');
        if (threat && dist(player, threat) > CLASSES[player.cls].range * 0.9) {
          moveToward(player, threat, CLASSES[player.cls].speed * 0.8, dt);
        }
      }
      tryAutoAttack(dt);

      // camp regen
      if (Math.hypot(player.x - CAMP.x, player.y - CAMP.y) < 200) {
        player.hp = Math.min(player.maxHp, player.hp + player.maxHp * (0.03 + camp.lvl * 0.01) * dt);
      }
    }

    player.abilityTimer = Math.max(0, player.abilityTimer - dt);
    updateMobs(dt);
    updateBoss(dt);
    Sim.update(dt);

    // projectiles
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      let dead = p.t > p.life;
      const targets = boss ? mobs.concat([boss]) : mobs;
      for (const m of targets) {
        const r = m.isBoss ? m.r : m.type.r;
        if (Math.hypot(m.x - p.x, m.y - p.y) < r + 8) {
          hitTarget(m, p.dmg, true);
          if (p.splash) {
            for (const o of targets) {
              if (o !== m && Math.hypot(o.x - p.x, o.y - p.y) < p.splash) hitTarget(o, p.dmg * 0.5, true);
            }
            burst(p.x, p.y, '#c084fc', 6);
          }
          if (p.pierce > 0) p.pierce--;
          else { dead = true; }
          break;
        }
      }
      if (dead) projectiles.splice(i, 1);
    }

    // fx timers
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]; f.t += dt; f.y -= 26 * dt;
      if (f.t > 1.1) floaters.splice(i, 1);
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 60 * dt;
      if (p.t > p.life) particles.splice(i, 1);
    }
    if (tapMarker) { tapMarker.t += dt; if (tapMarker.t > 0.5) tapMarker = null; }

    // camera
    cam.x += (player.x - cam.x) * Math.min(1, dt * 5);
    cam.y += (player.y - cam.y) * Math.min(1, dt * 5);
    cam.x = clamp(cam.x, VW / 2, WORLD.w - VW / 2);
    cam.y = clamp(cam.y, VH / 2, WORLD.h - VH / 2);

    // HUD
    hpFill.style.width = clamp(player.hp / player.maxHp * 100, 0, 100) + '%';
    xpFill.style.width = clamp(player.xp / xpNeed(player.lvl) * 100, 0, 100) + '%';
    lvlTag.textContent = player.lvl;
    goldPlate.textContent = `🪙 ${player.gold}`;
    const cdPct = player.abilityTimer / CLASSES[player.cls].ability.cd * 100;
    abilityBtn.style.setProperty('--cd', cdPct + '%');
    cdNum.textContent = player.abilityTimer > 0 ? Math.ceil(player.abilityTimer) : '';
    donateBtn.style.display =
      (Math.hypot(player.x - CAMP.x, player.y - CAMP.y) < 220 && player.gold >= campCost()) ? 'block' : 'none';
    donateBtn.textContent = `⛺ Donate ${campCost()}🪙 to camp (lv ${camp.lvl})`;
  }

  // ─── Render ────────────────────────────────────────────────────
  function sx(x) { return x - cam.x + VW / 2; }
  function sy(y) { return y - cam.y + VH / 2; }
  function onScreen(x, y, pad) {
    const p = pad || 60;
    return x > cam.x - VW / 2 - p && x < cam.x + VW / 2 + p && y > cam.y - VH / 2 - p && y < cam.y + VH / 2 + p;
  }
  function emoji(e, x, y, size, flip) {
    ctx.save();
    ctx.translate(sx(x), sy(y));
    if (flip) ctx.scale(-1, 1);
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(e, 0, 0);
    ctx.restore();
  }
  function shadow(x, y, w) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(sx(x), sy(y) + 3, w, w * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  function nameTag(x, y, text, color) {
    ctx.font = '700 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const w = ctx.measureText(text).width + 8;
    ctx.fillRect(sx(x) - w / 2, sy(y) - 6, w, 13);
    ctx.fillStyle = color || '#fff';
    ctx.fillText(text, sx(x), sy(y) + 4);
  }
  function hpBar(x, y, frac, w) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(sx(x) - w / 2, sy(y), w, 4);
    ctx.fillStyle = frac > 0.4 ? '#4ade80' : '#f87171';
    ctx.fillRect(sx(x) - w / 2, sy(y), w * clamp(frac, 0, 1), 4);
  }

  function render() {
    // ground
    ctx.fillStyle = '#2c4431';
    ctx.fillRect(0, 0, VW, VH);
    // subtle grass texture stripes
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    const off = -(cam.y % 80);
    for (let y = off; y < VH; y += 80) ctx.fillRect(0, y, VW, 40);

    // camp ground + arena ring
    ctx.fillStyle = '#5b4a33';
    ctx.beginPath(); ctx.ellipse(sx(CAMP.x), sy(CAMP.y), 190, 120, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(148,163,184,0.5)'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.ellipse(sx(ARENA.x), sy(ARENA.y), 220, 150, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(60,42,33,0.55)';
    ctx.beginPath(); ctx.ellipse(sx(ARENA.x), sy(ARENA.y), 214, 144, 0, 0, Math.PI * 2); ctx.fill();

    // telegraphs under everything else
    for (const tg of telegraphs) {
      const p = tg.t / tg.warn;
      ctx.strokeStyle = 'rgba(248,113,113,0.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx(tg.x), sy(tg.y), tg.r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(248,113,113,0.25)';
      ctx.beginPath(); ctx.arc(sx(tg.x), sy(tg.y), tg.r * p, 0, Math.PI * 2); ctx.fill();
    }

    // tap marker
    if (tapMarker) {
      const p = tapMarker.t / 0.5;
      ctx.strokeStyle = `rgba(125,211,252,${1 - p})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx(tapMarker.x), sy(tapMarker.y), 18 * (1 - p) + 4, 0, Math.PI * 2); ctx.stroke();
    }

    // build y-sorted draw list
    const drawList = [];
    for (const d of deco) if (onScreen(d.x, d.y)) drawList.push({ y: d.y, f: () => emoji(d.e, d.x, d.y, d.s) });

    // campfire + tents scale with camp level
    drawList.push({ y: CAMP.y, f: () => {
      shadow(CAMP.x, CAMP.y, 14);
      emoji('🔥', CAMP.x, CAMP.y, 30 + camp.lvl * 2);
      if (Math.random() < 0.15) particles.push({ x: CAMP.x + rand(-6, 6), y: CAMP.y - 20, vx: rand(-8, 8), vy: -rand(20, 50), t: 0, life: 0.8, color: '#fb923c' });
    }});
    const tentN = Math.min(camp.lvl + 1, 7);
    for (let i = 0; i < tentN; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      const tx = CAMP.x + Math.cos(a) * 120, ty = CAMP.y + Math.sin(a) * 78;
      drawList.push({ y: ty, f: () => { shadow(tx, ty, 13); emoji(i === 0 ? '🚩' : '⛺', tx, ty, 26); } });
    }

    for (const m of mobs) {
      if (!onScreen(m.x, m.y)) continue;
      drawList.push({ y: m.y, f: () => {
        shadow(m.x, m.y, m.type.r * 0.8);
        if (m.hitFlash > 0) { ctx.globalAlpha = 0.6; }
        emoji(m.type.emoji, m.x, m.y + 6, m.type.r * 2);
        ctx.globalAlpha = 1;
        if (m.burn > 0) emoji('🔥', m.x + 8, m.y - 10, 10);
        if (m.hp < m.maxHp) hpBar(m.x, m.y - m.type.r * 2 - 4, m.hp / m.maxHp, 26);
      }});
    }

    for (const b of Sim.bots) {
      if (!onScreen(b.x, b.y)) continue;
      drawList.push({ y: b.y, f: () => {
        shadow(b.x, b.y, 10);
        emoji(b.emoji, b.x, b.y + 6, 26, b.facing < 0);
        nameTag(b.x, b.y - 30, `[${b.guild.tag}] ${b.name}`, b.guild.color);
      }});
    }

    if (boss) {
      drawList.push({ y: boss.y, f: () => {
        shadow(boss.x, boss.y, 34);
        if (boss.hitFlash > 0) ctx.globalAlpha = 0.6;
        emoji('🐗', boss.x, boss.y + 14, 92);
        ctx.globalAlpha = 1;
        if (boss.burn > 0) emoji('🔥', boss.x + 26, boss.y - 30, 18);
        nameTag(boss.x, boss.y - 66, 'Bramblehorn', '#fca5a5');
      }});
    }

    if (player.cls && !player.dead) {
      drawList.push({ y: player.y, f: () => {
        shadow(player.x, player.y, 11);
        emoji(CLASSES[player.cls].emoji, player.x, player.y + 6, 30, player.facing < 0);
        nameTag(player.x, player.y - 32, `[WNDR] You`, '#fbbf24');
      }});
    }

    drawList.sort((a, b) => a.y - b.y);
    for (const d of drawList) d.f();

    // projectiles / particles / floaters on top
    for (const p of projectiles) {
      ctx.save();
      ctx.translate(sx(p.x), sy(p.y));
      ctx.rotate(Math.atan2(p.vy, p.vx));
      ctx.font = `${p.size}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillStyle = '#fde68a';
      ctx.fillText(p.emoji, 0, 4);
      ctx.restore();
    }
    for (const p of particles) {
      ctx.globalAlpha = 1 - p.t / p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const f of floaters) {
      ctx.globalAlpha = clamp(1.4 - f.t, 0, 1);
      ctx.font = `900 ${f.size}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3;
      ctx.strokeText(f.text, sx(f.x), sy(f.y));
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, sx(f.x), sy(f.y));
    }
    ctx.globalAlpha = 1;
  }

  // ─── Main loop ─────────────────────────────────────────────────
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  setInterval(persist, 6000);
})();
