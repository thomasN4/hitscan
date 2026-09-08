// Browser integration for the two cargo elevators. The fixture controls goals
// and isolates actors; actual navigation, transport, collision and input run.
export async function checkElevators(page, { playerChecks = true } = {}) {
  return page.evaluate(async (playerChecks) => {
    const cs = window.__cs;
    const { transportRoute } = cs.nav;
    const frame = () => new Promise(r => requestAnimationFrame(r));
    const feet = () => cs.player.pos.y - cs.player.eyeHeight;
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const until = async (predicate, label, observe = () => {}) => {
      const deadline = performance.now() + 45000;
      do {
        await frame();
        observe();
        if (predicate()) return;
      } while (performance.now() < deadline);
      throw new Error(`${label}: bots=${JSON.stringify(cs.bots.filter(b => b.alive).map(b => ({ pos: b.mesh.position.toArray(), trip: b.elevatorTrip })))}, player=${cs.player.pos.toArray()}, elevators=${JSON.stringify(cs.elevators.map(e => ({ id: e.spec.id, y: e.collider.max.y, dock: e.dock, blocked: e.blocked })))}`);
    };
    const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
    const place = (x, y, z) => {
      cs.player.pos.set(x, y + cs.player.eyeHeight, z);
      cs.player.vel.set(0, 0, 0);
      cs.player.onGround = true;
    };
    const walk = async target => {
      key('KeyW', true);
      try {
        await until(() => Math.hypot(cs.player.pos.x - target.x, cs.player.pos.z - target.z) < 0.3,
          'player walk', () => { cs.game.yaw = Math.atan2(target.x - cs.player.pos.x, target.z - cs.player.pos.z) + Math.PI; });
      } finally { key('KeyW', false); }
    };
    const actorState = cs.bots.map(b => ({ b, alive: b.alive, visible: b.mesh.visible }));
    const oldHp = cs.player.hp;
    const oldRound = cs.game.roundTime;
    for (const { b } of actorState) { b.alive = false; b.mesh.visible = false; }
    cs.player.hp = 100000;
    cs.game.roundTime = 10000;
    cs.game.shooting = false;
    const result = [];
    try {
      check(cs.elevators.length === 2, 'expected two cargo elevators');
      if (playerChecks) {
        for (const e of cs.elevators) {
          const s = e.spec;
          place(s.lowerLanding.x, 0, s.lowerLanding.z);
          await until(() => e.dock === 'lower', 'lower dock');
          await walk({ x: s.x, z: s.z });
          let movingFrames = 0;
          await until(() => e.dock === 'upper', 'ride upward', () => {
            if (e.deltaY > 0) {
              movingFrames++;
              check(cs.player.onGround && Math.abs(feet() - e.collider.max.y) < 0.01, 'upward passenger lost support');
              check(cs.player.vel.y === 0, 'elevator imparted launch velocity');
            }
          });
          check(movingFrames > 10, 'upward ride did not sample motion');
          await walk(s.upperLanding);
          check(Math.abs(feet() - s.upperY) < 0.01, 'upper exit is not flush');
          // Wait out the current upper stop before boarding the next one; this
          // proves the landing remains safe while the deck is absent.
          await until(() => e.dock === null, 'depart upper dock');
          await until(() => e.dock === 'upper', 'return upper dock');
          await walk({ x: s.x, z: s.z });
          movingFrames = 0;
          await until(() => e.dock === 'lower', 'ride downward', () => {
            if (e.deltaY < 0) {
              movingFrames++;
              check(cs.player.onGround && Math.abs(feet() - e.collider.max.y) < 0.01, 'downward passenger lost support');
            }
          });
          check(movingFrames > 10, 'downward ride did not sample motion');
          await walk(s.lowerLanding);
          await until(() => cs.player.onGround && Math.abs(feet()) < 0.01, 'lower exit');
          result.push({ id: s.id, player: 'up/down/boarding/exits' });
        }
        const e = cs.elevators[0], s = e.spec;
        place(s.lowerLanding.x, 0, s.lowerLanding.z);
        await until(() => e.dock === 'lower', 'jump fixture dock');
        await walk({ x: s.x, z: s.z });
        await until(() => e.deltaY > 0 && e.collider.max.y > 1, 'moving jump fixture');
        cs.game.locked = false;
        const paused = e.elapsed, pausedFeet = feet();
        for (let i = 0; i < 20; i++) await frame();
        check(e.elapsed === paused && feet() === pausedFeet, 'pause moved elevator or rider');
        cs.game.locked = true;
        key('Space', true);
        await until(() => !cs.player.onGround && feet() > e.collider.max.y + 0.1, 'jump detachment');
        key('Space', false);
        await until(() => cs.player.onGround, 'land after jump');
        // Real weapon raycasts attach a decal to the deck, not the scene.
        cs.game.pitch = -1.55;
        cs.weapon.mag = 30;
        cs.game.shooting = true;
        await until(() => cs.bulletHoles.some(h => h.parent === e.mesh), 'moving surface bullet hit');
        cs.game.shooting = false;
        const hole = cs.bulletHoles.find(h => h.parent === e.mesh);
        const local = hole.position.clone();
        const y = e.collider.max.y;
        await until(() => Math.abs(e.collider.max.y - y) > 0.3, 'decal motion');
        check(hole.position.distanceTo(local) < 1e-6 && hole.parent === e.mesh, 'decal detached during motion');
      }
      place(0, 0, -6);
      cs.game.pitch = 0;
      // Give the real route follower a fixed goal to avoid combat/patrol RNG.
      const bot = cs.bots[0];
      const originalDecide = bot.brain.decide;
      const originalPosition = bot.mesh.position.clone();
      bot.alive = true;
      bot.mesh.visible = true;
      try {
        for (const elevator of cs.elevators) {
          for (const destination of ['upper', 'lower']) {
            const spec = elevator.spec;
            const start = destination === 'upper' ? spec.lowerLanding : spec.upperLanding;
            const goal = destination === 'upper' ? spec.upperLanding : spec.lowerLanding;
            const path = transportRoute(start, goal);
            check(path?.some(w => w.elevatorId === spec.id), `route did not select ${spec.id} ${destination}`);
            bot.clearRouteCache();
            bot.elevatorTrip = null;
            bot.mesh.position.copy(start);
            bot.vy = 0;
            bot.onGround = true;
            const phases = new Set();
            bot.brain.decide = (view, dt) => {
              const toward = view.nextWaypoint(goal);
              const step = toward?.clone().clampLength(0, view.selfSpeed * dt) ?? goal.clone().set(0, 0, 0);
              return { mode: 'route', step, wantShoot: false, focusId: null, lookAt: null, facing: view.facing };
            };
            await until(() => bot.mesh.position.distanceTo(goal) < 0.3 && bot.elevatorTrip === null,
              `bot ${spec.id} ${destination}`, () => {
                if (bot.elevatorTrip) phases.add(bot.elevatorTrip.phase);
              });
            check(phases.has('ride') && phases.has('exit'), 'bot reached floor without completing transport');
            result.push({ id: spec.id, bot: destination, phases: [...phases] });
          }
        }
        // An interrupted wait cancels, but an interrupted ride must reach
        // its chosen landing even when the brain stops asking for a route.
        const elevator = cs.elevators[0], spec = elevator.spec;
        const hold = view => ({ mode: 'hold', step: view.facing.clone().set(0, 0, 0),
          wantShoot: false, focusId: null, lookAt: null, facing: view.facing });
        const routeUp = (view, dt) => {
          const toward = view.nextWaypoint(spec.upperLanding);
          return { ...hold(view), mode: 'route', step: toward?.clone().clampLength(0, view.selfSpeed * dt) ?? view.facing.clone().set(0, 0, 0) };
        };
        bot.mesh.position.copy(spec.lowerLanding);
        bot.onGround = true;
        bot.vy = 0;
        bot.clearRouteCache();
        bot.elevatorTrip = null;
        bot.brain.decide = hold;
        await until(() => elevator.dock === 'upper', 'interruption fixture');
        bot.brain.decide = routeUp;
        await until(() => bot.elevatorTrip?.phase === 'wait', 'bot waiting');
        bot.brain.decide = hold;
        await frame();
        check(bot.elevatorTrip === null, 'interrupted unboarded trip survived');
        bot.brain.decide = routeUp;
        await until(() => bot.elevatorTrip?.phase === 'ride', 'bot committed ride');
        bot.brain.decide = hold;
        await until(() => bot.elevatorTrip === null && bot.mesh.position.distanceTo(spec.upperLanding) < 0.3,
          'interrupted ride did not finish');
        // Interrupt on the frame just after input first establishes support,
        // before the next transport transition has had a chance to run.
        bot.mesh.position.copy(spec.lowerLanding);
        bot.onGround = true;
        bot.vy = 0;
        bot.clearRouteCache();
        bot.elevatorTrip = null;
        bot.brain.decide = routeUp;
        await until(() => bot.elevatorTrip?.phase === 'board' && bot.onGround
          && Math.abs(bot.mesh.position.y - elevator.collider.max.y) < 0.01,
          'first boarding support');
        bot.brain.decide = hold;
        await frame();
        check(bot.elevatorTrip?.phase === 'ride', 'first supported boarding frame was cancelled');
        await until(() => bot.elevatorTrip === null && bot.mesh.position.distanceTo(spec.upperLanding) < 0.3,
          'boarding interruption did not finish');
        // Respawn owns transport cleanup along with all other per-life state.
        bot.elevatorTrip = { id: spec.id, destination: 'lower', phase: 'ride' };
        bot.respawn();
        check(bot.elevatorTrip === null && bot.navPath.length === 0, 'respawn retained transport state');
        result.push({ interruptions: 'wait cancels; ride finishes; respawn clears' });
      } finally {
        bot.brain.decide = originalDecide;
        bot.elevatorTrip = null;
        bot.clearRouteCache();
        bot.mesh.position.copy(originalPosition);
        bot.vy = 0;
      }
      return result;
    } finally {
      key('KeyW', false);
      key('Space', false);
      cs.game.shooting = false;
      cs.game.locked = true;
      cs.player.hp = oldHp;
      cs.game.roundTime = oldRound;
      for (const { b, alive, visible } of actorState) { b.alive = alive; b.mesh.visible = visible; }
    }
  }, playerChecks);
}
