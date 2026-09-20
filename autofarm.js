// autofarm.js — load AFTER game.js in index.html:
//   <script src="autofarm.js"></script>
// Press F (or click the button) to toggle. The farm area is a circle centered
// where you were standing when you turned it on.

(() => {
  // ===== 1) MAP THESE TO YOUR GAME (the only part you should need to edit) =====
  const G = {
    getPlayer: () => window.player,
    getMobs: () => window.mobs || window.enemies || [],
    isAlive: (e) => !!e && e.hp > 0,
    attackRange: 40,        // how close the player must be to hit a mob
    attackCooldownMs: 600,  // delay between attacks
    speed: 2.5,             // pixels moved per tick while chasing
    hpFraction: (p) => p.hp / (p.maxHp || p.maxHP || 100),
    // Use your game's own attack if it has one, otherwise fall back to raw damage
    attack: (p, mob) => {
      if (typeof window.attackMob === 'function') return window.attackMob(mob);
      if (typeof window.attack === 'function') return window.attack(mob);
      mob.hp -= p.damage || p.atk || 5;
    },
    moveBy: (p, dx, dy) => { p.x += dx; p.y += dy; },
  };

  // ===== 2) FARM SETTINGS =====
  const FARM = {
    radius: 250,       // only mobs inside this circle are targeted
    stopBelowHp: 0.3,  // auto-stop when HP drops under 30%
    tickMs: 50,
  };

  // ===== 3) LOGIC =====
  const state = { on: false, cx: 0, cy: 0, lastAttack: 0, timer: null };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function tick() {
    const p = G.getPlayer();
    if (!p || !G.isAlive(p) || G.hpFraction(p) < FARM.stopBelowHp) return stop();

    const center = { x: state.cx, y: state.cy };
    let target = null, best = Infinity;
    for (const m of G.getMobs()) {
      if (!G.isAlive(m) || dist(m, center) > FARM.radius) continue;
      const d = dist(m, p);
      if (d < best) { best = d; target = m; }
    }

    // No mobs left in the area: drift back to the center and wait for respawns
    if (!target) {
      const d = dist(p, center);
      if (d > 10) G.moveBy(p, ((center.x - p.x) / d) * G.speed, ((center.y - p.y) / d) * G.speed);
      return;
    }

    if (best > G.attackRange) {
      G.moveBy(p, ((target.x - p.x) / best) * G.speed, ((target.y - p.y) / best) * G.speed);
    } else if (performance.now() - state.lastAttack >= G.attackCooldownMs) {
      state.lastAttack = performance.now();
      G.attack(p, target);
    }
  }

  function start() {
    const p = G.getPlayer();
    if (!p || state.on) return;
    state.cx = p.x; state.cy = p.y;
    state.on = true;
    state.timer = setInterval(tick, FARM.tickMs);
    render();
  }

  function stop() {
    clearInterval(state.timer);
    state.on = false;
    render();
  }

  const toggle = () => (state.on ? stop() : start());

  // ===== 4) TOGGLE UI =====
  const btn = document.createElement('button');
  btn.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:9999;padding:8px 14px;cursor:pointer';
  btn.onclick = toggle;
  document.body.appendChild(btn);
  function render() { btn.textContent = state.on ? 'Auto Farm: ON (F)' : 'Auto Farm: OFF (F)'; }
  render();

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // don't fire while typing
    if (e.key.toLowerCase() === 'f') toggle();
  });

  window.AutoFarm = { start, stop, toggle, FARM, G };
})();
