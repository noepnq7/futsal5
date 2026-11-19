// Futsal 5: cinco contra cinco con las reglas del futsal.
// Arquero, dos tiempos con cambio de lado, saque de banda, tiro de esquina, saque de arco, faltas acumuladas,
// tarjetas (la roja es de 2 minutos), penales y doble penal, regla de los 4 segundos. Sin posición adelantada, como en el futsal.
import { defineRoom, type Player, type Room } from "../net/server";
import {
  attackDir,
  BALL_R,
  BOT_SPEED,
  COUNTDOWN_SECONDS,
  DASH_SPEED,
  END_SECONDS,
  FOULS_LIMIT,
  Fx,
  game,
  GK_CATCH_SPEED,
  GK_HOLD_MS,
  GK_PICKUP_R,
  GOAL_DEPTH,
  GOAL_HALF,
  GOAL_SECONDS,
  HALF_L,
  HALF_SECONDS,
  HALF_W,
  HALFTIME_SECONDS,
  inPenaltyArea,
  KICK_RANGE,
  LONG_RESTART_SECONDS,
  MAX_TEAM,
  MIN_TEAM,
  OUT_SECONDS,
  PASS_SPEED,
  Phase,
  PICKUP_R,
  Rk,
  RULE_SECONDS,
  SHOT_MAX,
  SHOT_MIN,
  slotSpot,
  SPOT,
  SPOT2,
  TACKLE_CD,
  TACKLE_RANGE,
  Team,
  TEAMS,
  TRICK_CD,
  TRICK_MS,
  TRICK_NAMES,
} from "../shared";

type R = Room<typeof game.state>;

const BOT_NAMES = ["Tano", "Chiqui", "Nacho", "Pepe", "Lalo", "Coco", "Fede", "Mati", "Rulo", "Beto", "Dani", "Gabi"];
const FRICTION = 0.95;
const MAX_BALL = 26;
const GRAVITY = 20;
const POST_R = 0.07;

interface Cd {
  tackle: number;
  trick: number;
  shoot: number;
}
interface Disc {
  fouls: number;
  yellows: number;
  outUntil: number;
}
/** Una reanudación pendiente: la pelota está quieta en (x, z) esperando que saque `taker`. */
interface Rst {
  kind: number;
  team: number;
  x: number;
  z: number;
  taker: number;
  deadline: number;
  kickAt: number;
}
interface Ctx {
  phaseEnds: number;
  matchLeft: number;
  /** Equipo que sacó del medio en el primer tiempo (el otro saca en el segundo). */
  firstKick: number;
  /** Equipo que recibió el último gol (saca del medio). */
  concede: number;
  bots: Set<number>;
  vx: number;
  vz: number;
  hv: number;
  /** Entidad que lleva la pelota, o -1 si está suelta. */
  owner: number;
  lastTouch: number;
  noPick: Map<number, number>;
  fxUntil: Map<number, number>;
  cd: Map<number, Cd>;
  disc: Map<number, Disc>;
  rst: Rst | null;
  fouls: [number, number];
  /** Desde cuándo el arquero tiene la pelota en las manos (0 = no la tiene). */
  gkHold: number;
  botNames: number;
}
/** Lo propio de cada jugador (no viaja al cliente). */
interface Mine {
  team: number;
  entity: number;
}

const ctxs = new WeakMap<R, Ctx>();
const ctx = (room: R) => ctxs.get(room)!;
const mine = (p: Player): Mine => (p.data.m ??= { team: 0, entity: -1 });
const all = (room: R) => [...room.players.values()];
const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const other = (team: number) => (team === Team.Red ? Team.Blue : Team.Red);
const half = (room: R) => room.state.game.half || 1;
const dirOf = (room: R, team: number) => attackDir(team, half(room));
const cdOf = (c: Ctx, id: number): Cd => {
  let v = c.cd.get(id);
  if (!v) {
    v = { tackle: 0, trick: 0, shoot: 0 };
    c.cd.set(id, v);
  }
  return v;
};
const discOf = (c: Ctx, id: number): Disc => {
  let v = c.disc.get(id);
  if (!v) {
    v = { fouls: 0, yellows: 0, outUntil: 0 };
    c.disc.set(id, v);
  }
  return v;
};

function setPhase(room: R, phase: number, seconds: number) {
  room.state.game.phase = phase;
  ctx(room).phaseEnds = Date.now() + seconds * 1000;
}

function humanOf(room: R, id: number): Player | undefined {
  return all(room).find((p) => mine(p).entity === id);
}
function seatOf(room: R, id: number) {
  const p = humanOf(room, id);
  return p ? room.state.seats.get(p.id) : undefined;
}
/** Si es un jugador (no un bot), lo manda a su nueva posición: su cliente es quien lo mueve. */
function teleport(room: R, id: number) {
  const p = humanOf(room, id);
  if (p) room.own(p, "people", id);
}

/** Todos los de un equipo. El primero es el arquero: quien pidió serlo, si no un bot, si no el primero. */
function teamOrder(room: R, team: number): number[] {
  const humans = all(room)
    .filter((p) => mine(p).team === team && mine(p).entity >= 0)
    .map((p) => mine(p).entity);
  const bots = [...ctx(room).bots].filter((id) => room.state.people.get(id)?.team === team).sort((a, b) => a - b);
  const everyone = [...humans, ...bots];
  const claimed = humans.find((id) => seatOf(room, id)?.gk);
  const gk = claimed ?? bots[0] ?? humans[0];
  if (gk === undefined) return [];
  return [gk, ...everyone.filter((id) => id !== gk)];
}
const isOut = (room: R, id: number) => room.state.people.get(id)?.fx === Fx.Out;
const activeOf = (room: R, team: number) => teamOrder(room, team).filter((id) => !isOut(room, id));

function refreshRoles(room: R) {
  for (const team of [Team.Red, Team.Blue]) {
    teamOrder(room, team).forEach((id, i) => {
      const e = room.state.people.get(id);
      if (e) e.gk = i === 0;
    });
  }
}

function popup(room: R, x: number, z: number, text: string, team: number) {
  room.broadcast("style", { x, z, text, team });
}

function setFx(room: R, id: number, fx: number, ms: number) {
  const e = room.state.people.get(id);
  if (!e) return;
  e.fx = fx;
  ctx(room).fxUntil.set(id, Date.now() + ms);
}

function expireFx(room: R) {
  const c = ctx(room);
  const now = Date.now();
  for (const [id, until] of c.fxUntil) {
    if (now < until) continue;
    const e = room.state.people.get(id);
    if (e && e.fx !== Fx.Out) e.fx = Fx.None;
    c.fxUntil.delete(id);
  }
}

/** Quién lleva la pelota (-1 = nadie). */
function setOwner(room: R, id: number) {
  const c = ctx(room);
  if (c.owner >= 0) {
    const o = room.state.people.get(c.owner);
    if (o) o.has = false;
  }
  c.owner = id;
  if (id < 0) return;
  const e = room.state.people.get(id);
  if (!e) {
    c.owner = -1;
    return;
  }
  e.has = true;
  c.lastTouch = id;
  c.vx = 0;
  c.vz = 0;
}

function resetBallAt(room: R, x: number, z: number) {
  const c = ctx(room);
  const b = room.state.ball.get(0)!;
  setOwner(room, -1);
  b.x = x;
  b.z = z;
  b.h = 0;
  c.vx = 0;
  c.vz = 0;
  c.hv = 0;
}

/** Todos a su lugar de saque (cada uno en su mitad de cancha). Los expulsados no se mueven. */
function placeFormation(room: R) {
  const c = ctx(room);
  for (const team of [Team.Red, Team.Blue]) {
    teamOrder(room, team).forEach((id, i) => {
      const e = room.state.people.get(id);
      if (!e || e.fx === Fx.Out) return;
      const s = slotSpot(team, i, half(room));
      e.x = s.x;
      e.z = s.z;
      e.yaw = dirOf(room, team) > 0 ? 0 : Math.PI;
      e.fx = Fx.None;
      e.has = false;
      c.fxUntil.delete(id);
    });
  }
  for (const p of room.players.values()) if (mine(p).entity >= 0) teleport(room, mine(p).entity);
}

function syncBots(room: R) {
  const c = ctx(room);
  for (const team of [Team.Red, Team.Blue]) {
    const humans = all(room).filter((p) => mine(p).team === team).length;
    const want = Math.max(0, MIN_TEAM - humans);
    const bots = [...c.bots].filter((id) => room.state.people.get(id)?.team === team);
    while (bots.length > want) {
      const id = bots.pop()!;
      if (c.owner === id) setOwner(room, -1);
      room.state.people.delete(id);
      c.bots.delete(id);
      c.cd.delete(id);
      c.fxUntil.delete(id);
      c.disc.delete(id);
    }
    while (bots.length < want) {
      const id = room.randomId("people");
      const slot = teamOrder(room, team).length;
      const s = slotSpot(team, slot, half(room));
      room.state.people.set(id, {
        x: s.x,
        z: s.z,
        yaw: dirOf(room, team) > 0 ? 0 : Math.PI,
        team,
        bot: true,
        name: BOT_NAMES[c.botNames++ % BOT_NAMES.length],
        fx: Fx.None,
        has: false,
        gk: false,
        card: 0,
      });
      c.bots.add(id);
      bots.push(id);
    }
  }
  refreshRoles(room);
  // Si el que iba a sacar ya no está, se vuelve a armar la reanudación.
  const r = c.rst;
  if (room.state.game.phase === Phase.Restart && r && !room.state.people.has(r.taker)) startRestart(room, r.kind, r.team, r.x, r.z);
}

// ── Reanudaciones: saque inicial, banda, esquina, saque de arco, tiro libre y penales ──

function chooseTaker(room: R, team: number, kind: number, x: number, z: number, pref?: number): number {
  const order = teamOrder(room, team);
  const act = activeOf(room, team);
  if (!act.length) return -1;
  if (kind === Rk.GoalClear) return act.includes(order[0]) ? order[0] : act[0];
  const field = act.filter((id) => id !== order[0]);
  const pool = field.length ? field : act;
  if (pref !== undefined && pool.includes(pref)) return pref;
  let best = pool[0];
  let bd = Infinity;
  for (const id of pool) {
    const e = room.state.people.get(id);
    if (!e) continue;
    const d = dist(e.x, e.z, x, z);
    if (d < bd) {
      bd = d;
      best = id;
    }
  }
  return best;
}

function startRestart(room: R, kind: number, team: number, x: number, z: number, pref?: number) {
  const c = ctx(room);
  const g = room.state.game;
  const prev = c.rst ? room.state.people.get(c.rst.taker) : undefined;
  if (prev) prev.has = false;
  resetBallAt(room, x, z);
  c.gkHold = 0;
  const taker = chooseTaker(room, team, kind, x, z, pref);
  const te = taker >= 0 ? room.state.people.get(taker) : undefined;
  if (!te) {
    c.rst = null;
    g.rkind = 0;
    setPhase(room, Phase.Playing, 0);
    return;
  }
  const dir = dirOf(room, team);
  const side = Math.sign(x) || dir;
  // El que saca se pone junto a la pelota, mirando hacia donde va a jugar.
  if (kind === Rk.Kickoff) {
    te.x = x - dir * 0.9;
    te.z = z;
    te.yaw = dir > 0 ? 0 : Math.PI;
  } else if (kind === Rk.Penalty || kind === Rk.Penalty10) {
    te.x = x - side * 0.9;
    te.z = z;
    te.yaw = side > 0 ? 0 : Math.PI;
  } else if (kind === Rk.GoalClear) {
    te.x = x + side * 0.7;
    te.z = z;
    te.yaw = side > 0 ? Math.PI : 0;
  } else {
    let ux = -x;
    let uz = -z;
    const l = Math.hypot(ux, uz);
    if (l < 0.5) {
      ux = dir;
      uz = 0;
    } else {
      ux /= l;
      uz /= l;
    }
    te.x = x + ux * 0.9;
    te.z = z + uz * 0.9;
    te.yaw = Math.atan2(uz, ux);
  }
  te.x = clamp(te.x, -(HALF_L - 0.2), HALF_L - 0.2);
  te.z = clamp(te.z, -(HALF_W - 0.2), HALF_W - 0.2);
  te.fx = Fx.None;
  te.has = true;
  c.fxUntil.delete(taker);
  const now = Date.now();
  const rule = kind === Rk.KickIn || kind === Rk.Corner || kind === Rk.GoalClear || kind === Rk.Free;
  c.rst = { kind, team, x, z, taker, deadline: now + (rule ? RULE_SECONDS : LONG_RESTART_SECONDS) * 1000, kickAt: now + 1200 + room.random() * 1400 };
  g.rkind = kind;
  g.rteam = team;
  g.rradius = kind === Rk.Kickoff || kind === Rk.Penalty || kind === Rk.Penalty10 ? 3 : 5;
  g.rleft = rule ? RULE_SECONDS : LONG_RESTART_SECONDS;
  setPhase(room, Phase.Restart, 0);
  teleport(room, taker);
  enforceZone(room);
}

/** Los rivales no pueden estar cerca de la pelota; en los penales, todos van detrás de ella (menos el que patea y el arquero). */
function enforceZone(room: R) {
  const r = ctx(room).rst;
  if (!r) return;
  const R_ = room.state.game.rradius;
  const penalty = r.kind === Rk.Penalty || r.kind === Rk.Penalty10;
  const side = Math.sign(r.x) || 1;
  const defGk = penalty ? teamOrder(room, other(r.team))[0] : -1;
  for (const team of [Team.Red, Team.Blue]) {
    for (const id of activeOf(room, team)) {
      if (id === r.taker || id === defGk) continue;
      const e = room.state.people.get(id);
      if (!e) continue;
      let nx = e.x;
      let nz = e.z;
      let moved = false;
      if (penalty) {
        const lim = side * r.x - 1.5;
        if (side * nx > lim) {
          nx = side * lim;
          moved = true;
        }
      }
      if (team !== r.team || penalty) {
        const d = dist(nx, nz, r.x, r.z);
        if (d < R_) {
          const a = d > 0.01 ? Math.atan2(nz - r.z, nx - r.x) : side > 0 ? Math.PI : 0;
          nx = r.x + Math.cos(a) * (R_ + 0.3);
          nz = r.z + Math.sin(a) * (R_ + 0.3);
          moved = true;
        }
      }
      if (!moved) continue;
      e.x = clamp(nx, -(HALF_L - 0.4), HALF_L - 0.4);
      e.z = clamp(nz, -(HALF_W - 0.4), HALF_W - 0.4);
      teleport(room, id);
    }
  }
}

function resumePlay(room: R) {
  const c = ctx(room);
  const g = room.state.game;
  const t = c.rst ? room.state.people.get(c.rst.taker) : undefined;
  if (t) t.has = false;
  c.rst = null;
  Object.assign(g, { rkind: 0, rleft: 0, rradius: 0 });
  setPhase(room, Phase.Playing, 0);
}

function botRestartKick(room: R) {
  const c = ctx(room);
  const r = c.rst;
  if (!r) return;
  const e = room.state.people.get(r.taker);
  if (!e) return;
  const dir = dirOf(room, r.team);
  const goalX = dir * HALF_L;
  if (r.kind === Rk.Penalty || r.kind === Rk.Penalty10 || (r.kind === Rk.Free && dist(e.x, e.z, goalX, 0) < 11)) {
    const a = Math.atan2((room.random() * 2 - 1) * GOAL_HALF * 0.75 - e.z, goalX - e.x);
    doShoot(room, r.taker, a, 0.9);
    return;
  }
  const tx = r.kind === Rk.GoalClear ? dir * 8 : r.kind === Rk.Corner ? r.x - Math.sign(r.x) * 6 : e.x + dir * 6;
  const tz = r.kind === Rk.KickIn ? -Math.sign(r.z) * 4 : 0;
  const a = Math.atan2(tz - e.z, tx - e.x);
  if (!doPass(room, r.taker, a, true)) doShoot(room, r.taker, a, 0.55);
}

function restartTick(room: R) {
  const c = ctx(room);
  const g = room.state.game;
  const r = c.rst;
  if (!r) {
    setPhase(room, Phase.Playing, 0);
    return;
  }
  const now = Date.now();
  g.rleft = Math.max(0, Math.ceil((r.deadline - now) / 1000));
  enforceZone(room);
  if (!room.state.people.has(r.taker)) return startRestart(room, r.kind, r.team, r.x, r.z);
  if (c.bots.has(r.taker) && now >= r.kickAt) return botRestartKick(room);
  if (now < r.deadline) return;
  // Se pasaron los segundos: en el saque inicial y los penales se patea solo; en el resto pierde la reanudación.
  if (r.kind === Rk.Kickoff || r.kind === Rk.Penalty || r.kind === Rk.Penalty10) return botRestartKick(room);
  popup(room, r.x, r.z, "¡Pasaron los 4 segundos!", r.team);
  const opp = other(r.team);
  if (r.kind === Rk.KickIn) startRestart(room, Rk.KickIn, opp, r.x, r.z);
  else if (r.kind === Rk.Corner) startRestart(room, Rk.GoalClear, opp, (Math.sign(r.x) || 1) * (HALF_L - 2.5), 0);
  else startRestart(room, Rk.Free, opp, r.x, r.z);
}

function startKickoff(room: R, team: number) {
  placeFormation(room);
  startRestart(room, Rk.Kickoff, team, 0, 0);
}

// ── Faltas, tarjetas y expulsiones ──

function benchSpot(team: number, id: number) {
  return { x: (team === Team.Red ? -6 : 6) + (id % 5) * 1.1, z: -(HALF_W + 2.2) };
}

function sendOff(room: R, id: number) {
  const c = ctx(room);
  const e = room.state.people.get(id);
  if (!e) return;
  if (c.owner === id) setOwner(room, -1);
  const d = discOf(c, id);
  d.outUntil = Date.now() + OUT_SECONDS * 1000;
  e.card = 2;
  e.fx = Fx.Out;
  e.has = false;
  c.fxUntil.delete(id);
  const b = benchSpot(e.team, id);
  e.x = b.x;
  e.z = b.z;
  teleport(room, id);
  const seat = seatOf(room, id);
  if (seat) seat.card = 2;
  popup(room, e.x, -HALF_W + 0.5, `¡Roja para ${e.name}! 2 minutos`, e.team);
}

function returnFromOut(room: R, id: number) {
  const c = ctx(room);
  const e = room.state.people.get(id);
  if (!e || e.fx !== Fx.Out) return;
  const d = discOf(c, id);
  d.yellows = 0;
  d.outUntil = 0;
  e.card = 0;
  e.fx = Fx.None;
  const i = Math.max(0, teamOrder(room, e.team).indexOf(id));
  const s = slotSpot(e.team, i, half(room));
  e.x = s.x;
  e.z = -(HALF_W - 0.6);
  teleport(room, id);
  const seat = seatOf(room, id);
  if (seat) seat.card = 0;
  popup(room, e.x, e.z, `${e.name} vuelve a la cancha`, e.team);
}

function giveYellow(room: R, id: number) {
  const e = room.state.people.get(id);
  if (!e) return;
  const d = discOf(ctx(room), id);
  d.yellows++;
  if (d.yellows >= 2) {
    popup(room, e.x, e.z, "Doble amarilla", e.team);
    sendOff(room, id);
    return;
  }
  e.card = 1;
  const seat = seatOf(room, id);
  if (seat) seat.card = 1;
  popup(room, e.x, e.z, "Tarjeta amarilla", e.team);
}

/** Una falta: suma a las acumuladas, puede traer tarjeta, y se paga con tiro libre, penal o doble penal. */
function commitFoul(room: R, foulerId: number, victimId: number, x: number, z: number, reason: string, reckless: boolean) {
  const c = ctx(room);
  const g = room.state.game;
  const f = room.state.people.get(foulerId);
  if (!f) return;
  const team = f.team;
  c.fouls[team]++;
  g.foulsRed = c.fouls[0];
  g.foulsBlue = c.fouls[1];
  const d = discOf(c, foulerId);
  d.fouls++;
  const seat = seatOf(room, foulerId);
  if (seat) seat.fouls = Math.min(255, seat.fouls + 1);
  setOwner(room, -1);
  const defSide = -dirOf(room, team); // lado del arco que defiende el que cometió la falta
  const opp = other(team);
  let kind: number = Rk.Free;
  if (inPenaltyArea(x, z, defSide)) kind = Rk.Penalty;
  else if (c.fouls[team] > FOULS_LIMIT) kind = Rk.Penalty10;
  room.broadcast("foul", { team, name: f.name, reason, count: c.fouls[team], kind });
  if (reckless || d.fouls % 3 === 0) giveYellow(room, foulerId);
  if (kind === Rk.Penalty) startRestart(room, Rk.Penalty, opp, defSide * (HALF_L - SPOT), 0, victimId);
  else if (kind === Rk.Penalty10) startRestart(room, Rk.Penalty10, opp, defSide * (HALF_L - SPOT2), 0, victimId);
  else startRestart(room, Rk.Free, opp, clamp(x, -(HALF_L - 1), HALF_L - 1), clamp(z, -(HALF_W - 1), HALF_W - 1), victimId);
}

/** El arquero no puede tener la pelota en las manos más de 4 segundos dentro de su área. */
function checkGkHold(room: R) {
  const c = ctx(room);
  const o = c.owner >= 0 ? room.state.people.get(c.owner) : undefined;
  if (!o || !o.gk || !inPenaltyArea(o.x, o.z, -dirOf(room, o.team))) {
    c.gkHold = 0;
    return;
  }
  const now = Date.now();
  if (c.gkHold === 0) c.gkHold = now;
  else if (now - c.gkHold > GK_HOLD_MS) {
    popup(room, o.x, o.z, "¡Arquero, 4 segundos!", o.team);
    startRestart(room, Rk.Free, other(o.team), o.x, o.z);
  }
}

// ── Acciones de juego ──

/** ¿Puede este jugador patear o pasar ahora? Con la pelota, o sacando una reanudación estando cerca. */
function gate(room: R, id: number): "carry" | "restart" | null {
  const c = ctx(room);
  const g = room.state.game;
  const e = room.state.people.get(id);
  const b = room.state.ball.get(0);
  if (!e || !b || e.fx === Fx.Out || e.fx === Fx.Stun) return null;
  if (g.phase === Phase.Restart) return c.rst && c.rst.taker === id && dist(e.x, e.z, b.x, b.z) <= 2.6 ? "restart" : null;
  if (g.phase !== Phase.Playing && g.phase !== Phase.Lobby) return null;
  if (c.owner === id) return "carry";
  if (c.owner < 0 && dist(e.x, e.z, b.x, b.z) <= KICK_RANGE) return "carry";
  return null;
}

function doShoot(room: R, id: number, angle: number, power: number): boolean {
  const c = ctx(room);
  const b = room.state.ball.get(0);
  const mode = gate(room, id);
  if (!mode || !b) return false;
  const p = clamp(power, 0, 1);
  const speed = SHOT_MIN + (SHOT_MAX - SHOT_MIN) * p;
  if (mode === "restart") resumePlay(room);
  setOwner(room, -1);
  c.vx = Math.cos(angle) * speed;
  c.vz = Math.sin(angle) * speed;
  c.lastTouch = id;
  c.gkHold = 0;
  c.noPick.set(id, Date.now() + 400);
  room.broadcast("kick", { x: b.x, z: b.z, power: p });
  return true;
}

/** Pase al compañero que mejor quede en la dirección elegida. */
function doPass(room: R, id: number, angle: number, needMate: boolean): boolean {
  const c = ctx(room);
  const e = room.state.people.get(id);
  const b = room.state.ball.get(0);
  const mode = gate(room, id);
  if (!e || !b || !mode || (mode === "carry" && c.owner !== id)) return false;
  let mate = -1;
  let bestScore = -Infinity;
  for (const mid of activeOf(room, e.team)) {
    if (mid === id) continue;
    const m = room.state.people.get(mid);
    if (!m) continue;
    const d = dist(e.x, e.z, m.x, m.z);
    if (d < 1.5 || d > 24) continue;
    const cos = (Math.cos(angle) * (m.x - e.x) + Math.sin(angle) * (m.z - e.z)) / d;
    if (cos < 0.55) continue;
    const score = cos * 2 - d * 0.03;
    if (score > bestScore) {
      bestScore = score;
      mate = mid;
    }
  }
  if (mate < 0 && needMate) return false;
  let a = angle;
  let speed = 12;
  if (mate >= 0) {
    const m = room.state.people.get(mate)!;
    a = Math.atan2(m.z - b.z, m.x - b.x);
    speed = dist(e.x, e.z, m.x, m.z) > 10 ? PASS_SPEED * 1.15 : PASS_SPEED;
  }
  if (mode === "restart") resumePlay(room);
  setOwner(room, -1);
  c.vx = Math.cos(a) * speed;
  c.vz = Math.sin(a) * speed;
  c.lastTouch = id;
  c.gkHold = 0;
  c.noPick.set(id, Date.now() + 300);
  room.broadcast("kick", { x: b.x, z: b.z, power: 0.4 });
  return true;
}

/** Gambeta: un movimiento con la pelota pegada; mientras dura, nadie te la saca (y quien lo intente queda humillado). */
function doTrick(room: R, id: number): boolean {
  const c = ctx(room);
  const e = room.state.people.get(id);
  const k = cdOf(c, id);
  const now = Date.now();
  if (!e || c.owner !== id || e.fx !== Fx.None || now < k.trick) return false;
  k.trick = now + TRICK_CD;
  setFx(room, id, Fx.Trick, TRICK_MS);
  c.hv = 5.5;
  popup(room, e.x, e.z, TRICK_NAMES[Math.floor(room.random() * TRICK_NAMES.length)], e.team);
  return true;
}

/** Barrida: puede ganar la pelota limpia o ser falta (por la espalda siempre lo es, y con amarilla). */
function doTackle(room: R, id: number): boolean {
  const c = ctx(room);
  const e = room.state.people.get(id);
  const k = cdOf(c, id);
  const now = Date.now();
  if (!e || room.state.game.phase !== Phase.Playing || e.fx !== Fx.None || now < k.tackle) return false;
  const o = c.owner >= 0 ? room.state.people.get(c.owner) : undefined;
  if (!o || o.team === e.team || dist(e.x, e.z, o.x, o.z) > TACKLE_RANGE) return false;
  // Al arquero con la pelota en las manos, dentro de su área, no se le puede sacar.
  if (o.gk && inPenaltyArea(o.x, o.z, -dirOf(room, o.team))) return false;
  k.tackle = now + TACKLE_CD;
  if (o.fx === Fx.Trick) {
    setFx(room, id, Fx.Stun, 1400);
    popup(room, e.x, e.z, "¡HUMILLADO!", o.team);
    return true;
  }
  const dd = Math.max(0.01, dist(e.x, e.z, o.x, o.z));
  const behind = ((e.x - o.x) * Math.cos(o.yaw) + (e.z - o.z) * Math.sin(o.yaw)) / dd < -0.25;
  if (behind) {
    commitFoul(room, id, c.owner, o.x, o.z, "por la espalda", true);
    return true;
  }
  if (room.random() < 0.75) {
    c.noPick.set(c.owner, now + 700);
    setOwner(room, id);
    popup(room, e.x, e.z, "¡Barrida limpia!", e.team);
  } else {
    commitFoul(room, id, c.owner, o.x, o.z, "zancadilla", false);
  }
  return true;
}

// ── La pelota ──

function goalScored(room: R, team: number) {
  const c = ctx(room);
  const g = room.state.game;
  if (team === Team.Red) g.red = Math.min(255, g.red + 1);
  else g.blue = Math.min(255, g.blue + 1);
  const toucher = room.state.people.get(c.lastTouch);
  const own = !!toucher && toucher.team !== team;
  if (toucher && !own && !toucher.bot) {
    const seat = seatOf(room, c.lastTouch);
    if (seat) seat.goals++;
  }
  c.concede = other(team);
  // Con un gol en contra, el equipo que jugaba con uno menos recupera a su jugador.
  for (const id of teamOrder(room, c.concede)) returnFromOut(room, id);
  setOwner(room, -1);
  room.broadcast("goal", { team, name: toucher?.name ?? "", own, red: g.red, blue: g.blue });
  setPhase(room, Phase.Goal, GOAL_SECONDS);
}

/** La pelota salió: banda, esquina o saque de arco, según quién la tocó última. */
function ballOut(room: R, touchline: boolean, x: number, z: number) {
  const c = ctx(room);
  const last = room.state.people.get(c.lastTouch)?.team ?? -1;
  if (touchline) {
    const team = last === Team.Red ? Team.Blue : last === Team.Blue ? Team.Red : Team.Red;
    popup(room, x, Math.sign(z) * (HALF_W - 0.5), "Banda", team);
    startRestart(room, Rk.KickIn, team, clamp(x, -(HALF_L - 1.5), HALF_L - 1.5), Math.sign(z) * HALF_W);
    return;
  }
  const side = Math.sign(x) || 1;
  const defTeam = attackDir(Team.Red, half(room)) === -side ? Team.Red : Team.Blue;
  if (last === defTeam) {
    popup(room, side * (HALF_L - 1), Math.sign(z) * (HALF_W - 1), "Tiro de esquina", other(defTeam));
    startRestart(room, Rk.Corner, other(defTeam), side * (HALF_L - 0.3), (Math.sign(z) || 1) * (HALF_W - 0.3));
  } else {
    popup(room, side * (HALF_L - 2), 0, "Saque de arco", defTeam);
    startRestart(room, Rk.GoalClear, defTeam, side * (HALF_L - 2.5), 0);
  }
}

function stepBall(room: R, dt: number) {
  const c = ctx(room);
  const g = room.state.game;
  const b = room.state.ball.get(0)!;
  const now = Date.now();
  const phase = g.phase;
  // Con la pelota quieta (reanudación, entretiempo, final) no hay nada que mover.
  if (phase === Phase.Restart || phase === Phase.Halftime || phase === Phase.End || phase === Phase.Countdown) return;
  c.hv -= GRAVITY * dt;
  let h = b.h + c.hv * dt;
  if (h <= 0) {
    h = 0;
    c.hv = c.hv < -3 ? -c.hv * 0.4 : 0;
  }
  b.h = h;

  let x = b.x;
  let z = b.z;
  let sp = 0;
  if (c.owner >= 0) {
    // Llevada: pegada al pie, un poco adelante, con toques. Puede irse afuera o meterse en el arco gambeteando.
    const o = room.state.people.get(c.owner);
    if (o) {
      const t = now / 1000;
      const lead = 0.8 + 0.12 * Math.sin(t * 9);
      const side = 0.15 * Math.sin(t * 4.5);
      const dx = Math.cos(o.yaw);
      const dz = Math.sin(o.yaw);
      x = o.x + dx * lead - dz * side;
      z = o.z + dz * lead + dx * side;
      b.x = x;
      b.z = z;
      c.vx = 0;
      c.vz = 0;
    } else setOwner(room, -1);
  }
  if (c.owner < 0) {
    let vx = c.vx;
    let vz = c.vz;
    const SUB = 3;
    const hh = dt / SUB;
    for (let s = 0; s < SUB; s++) {
      const f = Math.exp(-FRICTION * hh);
      vx *= f;
      vz *= f;
      x += vx * hh;
      z += vz * hh;
      // Postes: la pelota rebota.
      for (const sx of [1, -1]) {
        for (const sz of [1, -1]) {
          const dx = x - sx * HALF_L;
          const dz = z - sz * GOAL_HALF;
          const d = Math.hypot(dx, dz);
          if (d >= BALL_R + POST_R || d < 1e-6) continue;
          const nx = dx / d;
          const nz = dz / d;
          x = sx * HALF_L + nx * (BALL_R + POST_R);
          z = sz * GOAL_HALF + nz * (BALL_R + POST_R);
          const dot = vx * nx + vz * nz;
          if (dot < 0) {
            vx -= 1.6 * dot * nx;
            vz -= 1.6 * dot * nz;
          }
        }
      }
      // Red del arco: la pelota se frena adentro.
      for (const sign of [1, -1]) {
        if (sign * x > HALF_L && Math.abs(z) < GOAL_HALF) {
          if (Math.abs(z) > GOAL_HALF - BALL_R) {
            z = Math.sign(z) * (GOAL_HALF - BALL_R);
            vz = -vz * 0.5;
          }
          if (sign * x > HALF_L + GOAL_DEPTH - BALL_R) {
            x = sign * (HALF_L + GOAL_DEPTH - BALL_R);
            vx = -vx * 0.2;
          }
        }
      }
    }
    sp = Math.hypot(vx, vz);
    if (sp > MAX_BALL) {
      vx = (vx / sp) * MAX_BALL;
      vz = (vz / sp) * MAX_BALL;
      sp = MAX_BALL;
    }
    b.x = x;
    b.z = z;
    c.vx = vx;
    c.vz = vz;
  }

  // Reglas: gol, o pelota afuera (solo con la pelota en juego; en el calentamiento vuelve al medio).
  if (phase === Phase.Playing || phase === Phase.Lobby) {
    const crossed = Math.abs(x) > HALF_L + BALL_R;
    const outT = Math.abs(z) > HALF_W + BALL_R;
    if (crossed && Math.abs(z) < GOAL_HALF) {
      if (phase === Phase.Playing) goalScored(room, attackDir(Team.Red, half(room)) === Math.sign(x) ? Team.Red : Team.Blue);
      else resetBallAt(room, 0, 0);
      return;
    }
    if (crossed || outT) {
      if (phase === Phase.Playing) ballOut(room, outT && !crossed, x, z);
      else resetBallAt(room, 0, 0);
      return;
    }
  }

  // Recoger: el arquero ataja con las manos dentro de su área; los demás la controlan con el pie.
  if (c.owner >= 0 || (phase !== Phase.Playing && phase !== Phase.Lobby) || h > 0.9) return;
  let best = -1;
  let bd = Infinity;
  for (const id of room.state.people.keys()) {
    const e = room.state.people.get(id);
    if (!e || e.fx === Fx.Stun || e.fx === Fx.Out) continue;
    if ((c.noPick.get(id) ?? 0) > now) continue;
    const hands = e.gk && inPenaltyArea(x, z, -dirOf(room, e.team));
    if (sp >= (hands ? GK_CATCH_SPEED : 11)) continue;
    const d = dist(e.x, e.z, x, z);
    if (d < (hands ? GK_PICKUP_R : PICKUP_R) && d < bd) {
      bd = d;
      best = id;
    }
  }
  if (best >= 0) setOwner(room, best);
}

// ── Bots ──

function moveBots(room: R, dt: number, live: boolean) {
  const c = ctx(room);
  const g = room.state.game;
  const now = Date.now();
  const ball = room.state.ball.get(0)!;
  const ownerE = c.owner >= 0 ? room.state.people.get(c.owner) : undefined;
  const takerId = g.phase === Phase.Restart && c.rst ? c.rst.taker : -1;
  for (const team of [Team.Red, Team.Blue]) {
    const order = teamOrder(room, team);
    const act = order.filter((id) => !isOut(room, id));
    const gkId = order[0];
    const dir = dirOf(room, team);
    const hasBall = !!ownerE && ownerE.team === team;
    const focus: { x: number; z: number } = ownerE && !hasBall ? ownerE : ball;
    // Quien presiona: el más cercano a la pelota (o a quien la lleva); el arquero no sale.
    let chaser = -1;
    let best = Infinity;
    for (const id of act) {
      if (id === gkId || id === c.owner || id === takerId) continue;
      const e = room.state.people.get(id);
      if (!e) continue;
      const d = dist(e.x, e.z, focus.x, focus.z) - (c.bots.has(id) ? 0 : 2);
      if (d < best) {
        best = d;
        chaser = id;
      }
    }
    for (const id of act) {
      if (!c.bots.has(id) || id === takerId) continue;
      const e = room.state.people.get(id);
      if (!e || e.fx === Fx.Stun) continue;
      const slot = Math.max(1, order.indexOf(id));
      const k = cdOf(c, id);
      let tx: number;
      let tz: number;
      let speed = BOT_SPEED;
      if (id === gkId) {
        const lineX = -dir * (HALF_L - 1.1);
        if (c.owner === id) {
          // Con la pelota en las manos: la reparte antes de que se cumplan los 4 segundos.
          tx = e.x;
          tz = e.z;
          if (live && c.gkHold > 0 && now - c.gkHold > 1400 + (id % 3) * 500) {
            const a = Math.atan2((room.random() - 0.5) * 6, dir * 10);
            if (!doPass(room, id, a, true)) doShoot(room, id, a, 0.75);
          }
        } else if (c.owner < 0 && Math.hypot(c.vx, c.vz) < 9 && inPenaltyArea(ball.x, ball.z, -dir)) {
          tx = ball.x;
          tz = ball.z;
          speed = BOT_SPEED * 1.15;
        } else {
          tx = lineX;
          tz = clamp(ball.z * 0.45, -GOAL_HALF * 1.2, GOAL_HALF * 1.2);
        }
      } else if (e.fx === Fx.Trick) {
        tx = e.x + Math.cos(e.yaw) * 5;
        tz = e.z + Math.sin(e.yaw) * 5;
        speed = DASH_SPEED;
      } else if (id === c.owner) {
        // Con la pelota: va al arco rival, gambetea al que lo marca, pasa o remata desde cerca.
        tx = dir * HALF_L;
        tz = Math.sin(now / 650 + id) * 3.2;
        speed = BOT_SPEED * 0.92;
        e.yaw = Math.atan2(tz - e.z, tx - e.x);
        let near = Infinity;
        for (const oid of room.state.people.keys()) {
          const o = room.state.people.get(oid);
          if (o && o.team !== team && o.fx !== Fx.Out) near = Math.min(near, dist(e.x, e.z, o.x, o.z));
        }
        if (live) {
          if (dist(e.x, e.z, dir * HALF_L, 0) < 9.5 && now >= k.shoot) {
            const gz = (room.random() * 2 - 1) * GOAL_HALF * 0.65;
            const a = Math.atan2(gz - e.z, dir * HALF_L - e.x) + (room.random() - 0.5) * 0.1;
            if (doShoot(room, id, a, 0.7 + room.random() * 0.3)) k.shoot = now + 900;
          } else if (near < 2.4 && now >= k.trick && room.random() < 0.08) doTrick(room, id);
          else if (near < 3.2 && room.random() < 0.03) doPass(room, id, e.yaw, true);
        }
      } else if (hasBall && ownerE) {
        // Apoya: se abre por los costados, un poco adelante del que la lleva.
        tx = clamp(ownerE.x + dir * (2 + (slot % 2) * 3), -(HALF_L - 2), HALF_L - 2);
        tz = [5, -5, 2.5, -2.5][(slot - 1) % 4];
      } else if (id === chaser) {
        tx = focus.x;
        tz = focus.z;
        if (live && ownerE && !hasBall && now >= k.tackle && dist(e.x, e.z, ownerE.x, ownerE.z) < TACKLE_RANGE * 0.9 && room.random() < 0.4) {
          doTackle(room, id);
          k.tackle = now + 2800;
        }
      } else {
        // Marca: se cierra entre la pelota y su arco.
        tx = clamp(ball.x * 0.55 - dir * (slot <= 2 ? 6 : 3), -(HALF_L - 2), HALF_L - 2);
        tz = clamp(ball.z * 0.5 + [5, -5, 2.5, -2.5][(slot - 1) % 4] * 0.5, -(HALF_W - 1), HALF_W - 1);
      }
      const dx = tx - e.x;
      const dz = tz - e.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15 && speed > 0) {
        const step = Math.min(d, speed * dt);
        e.x = clamp(e.x + (dx / d) * step, -(HALF_L - 0.45), HALF_L - 0.45);
        e.z = clamp(e.z + (dz / d) * step, -(HALF_W - 0.45), HALF_W - 0.45);
        e.yaw = Math.atan2(dz, dx);
      }
    }
  }
}

// ── Partido ──

function clearMatch(room: R) {
  const g = room.state.game;
  const c = ctx(room);
  Object.assign(g, { red: 0, blue: 0, foulsRed: 0, foulsBlue: 0, rkind: 0, rteam: 0, rleft: 0, rradius: 0, half: 0 });
  c.fouls = [0, 0];
  c.rst = null;
  c.disc.clear();
  for (const id of room.state.people.keys()) {
    const e = room.state.people.get(id);
    if (e) {
      e.card = 0;
      e.fx = Fx.None;
      e.has = false;
    }
  }
  for (const p of room.players.values()) {
    const seat = room.state.seats.get(p.id);
    if (seat) Object.assign(seat, { goals: 0, fouls: 0, card: 0 });
  }
}

function toLobby(room: R) {
  clearMatch(room);
  setPhase(room, Phase.Lobby, 0);
  room.state.game.timeLeft = HALF_SECONDS;
  ctx(room).matchLeft = 0;
  placeFormation(room);
  resetBallAt(room, 0, 0);
}

function startMatch(room: R) {
  const g = room.state.game;
  clearMatch(room);
  g.half = 1;
  ctx(room).matchLeft = HALF_SECONDS;
  g.timeLeft = HALF_SECONDS;
  placeFormation(room);
  resetBallAt(room, 0, 0);
  setPhase(room, Phase.Countdown, COUNTDOWN_SECONDS);
  g.timeLeft = COUNTDOWN_SECONDS;
}

function endHalf(room: R) {
  const g = room.state.game;
  setOwner(room, -1);
  ctx(room).rst = null;
  Object.assign(g, { rkind: 0, rleft: 0, rradius: 0 });
  if (g.half === 1) {
    room.broadcast("halftime", { red: g.red, blue: g.blue });
    resetBallAt(room, 0, 0);
    setPhase(room, Phase.Halftime, HALFTIME_SECONDS);
    g.timeLeft = 0;
    return;
  }
  const rows = [...room.state.seats.keys()]
    .map((id) => room.state.seats.get(id)!)
    .map((s) => ({ name: s.name, team: s.team, goals: s.goals, fouls: s.fouls, card: s.card }))
    .sort((a, b) => b.goals - a.goals);
  const winner = g.red > g.blue ? Team.Red : g.blue > g.red ? Team.Blue : 2;
  room.broadcast("end", { red: g.red, blue: g.blue, winner, rows });
  setPhase(room, Phase.End, END_SECONDS);
  g.timeLeft = 0;
}

export default defineRoom({
  ...game,
  maxPlayers: MAX_TEAM * 2,
  tick: 20,

  onCreate(room) {
    ctxs.set(room, {
      phaseEnds: 0,
      matchLeft: 0,
      firstKick: Team.Red,
      concede: Team.Red,
      bots: new Set(),
      vx: 0,
      vz: 0,
      hv: 0,
      owner: -1,
      lastTouch: -1,
      noPick: new Map(),
      fxUntil: new Map(),
      cd: new Map(),
      disc: new Map(),
      rst: null,
      fouls: [0, 0],
      gkHold: 0,
      botNames: 0,
    });
    room.state.ball.set(0, { x: 0, z: 0, h: 0 });
    Object.assign(room.state.game, { kitRed: 0, kitBlue: 1, phase: Phase.Lobby, timeLeft: HALF_SECONDS, half: 0, red: 0, blue: 0, foulsRed: 0, foulsBlue: 0, rkind: 0, rteam: 0, rleft: 0, rradius: 0 });
    syncBots(room);
    placeFormation(room);
  },

  onJoin(room, p) {
    const reds = all(room).filter((q) => q !== p && mine(q).team === Team.Red).length;
    const blues = all(room).filter((q) => q !== p && mine(q).team === Team.Blue).length;
    const m = mine(p);
    m.team = blues < reds ? Team.Blue : Team.Red;
    m.entity = room.randomId("people");
    room.state.seats.set(p.id, { name: p.name, team: m.team, goals: 0, fouls: 0, card: 0, gk: false });
    const s = slotSpot(m.team, teamOrder(room, m.team).length, half(room));
    room.state.people.set(m.entity, {
      x: s.x,
      z: s.z,
      yaw: dirOf(room, m.team) > 0 ? 0 : Math.PI,
      team: m.team,
      bot: false,
      name: p.name,
      fx: Fx.None,
      has: false,
      gk: false,
      card: 0,
    });
    room.own(p, "people", m.entity);
    syncBots(room);
    room.broadcast("notice", { text: `${p.name} entró al equipo ${m.team === Team.Red ? "Rojo" : "Azul"}` }, p);
  },

  onLeave(room, p) {
    const m = mine(p);
    const c = ctx(room);
    room.state.seats.delete(p.id);
    if (m.entity >= 0) {
      if (c.owner === m.entity) setOwner(room, -1);
      room.state.people.delete(m.entity);
      c.cd.delete(m.entity);
      c.fxUntil.delete(m.entity);
      c.disc.delete(m.entity);
    }
    // Todavía figura en room.players mientras se va: lo saco de su equipo para contar bien.
    m.entity = -1;
    m.team = -1;
    syncBots(room);
    room.broadcast("notice", { text: `${p.name} salió` });
  },

  onTick(room, dt) {
    const g = room.state.game;
    const c = ctx(room);
    const now = Date.now();
    const left = Math.max(0, Math.ceil((c.phaseEnds - now) / 1000));
    expireFx(room);
    // Los expulsados vuelven a los 2 minutos.
    for (const [id, d] of c.disc) if (d.outUntil > 0 && now >= d.outUntil) returnFromOut(room, id);
    if (g.phase === Phase.Lobby) {
      stepBall(room, dt);
    } else if (g.phase === Phase.Countdown) {
      g.timeLeft = left;
      if (left === 0) {
        c.firstKick = room.random() < 0.5 ? Team.Red : Team.Blue;
        g.timeLeft = Math.ceil(c.matchLeft);
        startKickoff(room, c.firstKick);
      }
    } else if (g.phase === Phase.Playing) {
      c.matchLeft -= dt;
      g.timeLeft = Math.max(0, Math.ceil(c.matchLeft));
      moveBots(room, dt, true);
      stepBall(room, dt);
      if (g.phase === Phase.Playing) checkGkHold(room);
      if (g.phase === Phase.Playing && c.matchLeft <= 0) endHalf(room);
    } else if (g.phase === Phase.Restart) {
      moveBots(room, dt, false);
      restartTick(room);
    } else if (g.phase === Phase.Goal) {
      stepBall(room, dt);
      if (left === 0) startKickoff(room, c.concede);
    } else if (g.phase === Phase.Halftime) {
      if (left === 0) {
        // Segundo tiempo: se cambian de lado y saca el otro equipo.
        g.half = 2;
        c.matchLeft = HALF_SECONDS;
        g.timeLeft = HALF_SECONDS;
        c.fouls = [0, 0];
        g.foulsRed = 0;
        g.foulsBlue = 0;
        startKickoff(room, other(c.firstKick));
      }
    } else if (g.phase === Phase.End && left === 0) toLobby(room);
  },

  messages: {
    start(room) {
      if (room.state.game.phase !== Phase.Lobby) return;
      startMatch(room);
    },

    /** Cambiar de equipo, solo mientras se espera. */
    team(room, p) {
      if (room.state.game.phase !== Phase.Lobby) return;
      const m = mine(p);
      const to = other(m.team);
      if (all(room).filter((q) => mine(q).team === to).length >= MAX_TEAM) return;
      m.team = to;
      const e = room.state.people.get(m.entity);
      const seat = room.state.seats.get(p.id);
      if (seat) {
        seat.team = to;
        seat.gk = false;
      }
      if (e) {
        e.team = to;
        const s = slotSpot(to, Math.max(0, teamOrder(room, to).indexOf(m.entity)), half(room));
        e.x = s.x;
        e.z = s.z;
        e.yaw = dirOf(room, to) > 0 ? 0 : Math.PI;
        room.own(p, "people", m.entity);
      }
      syncBots(room);
    },

    /** Pedir (o dejar) el puesto de arquero de tu equipo, mientras se espera. */
    gk(room, p) {
      if (room.state.game.phase !== Phase.Lobby) return;
      const seat = room.state.seats.get(p.id);
      if (!seat) return;
      if (seat.gk) seat.gk = false;
      else {
        const taken = all(room).some((q) => q !== p && mine(q).team === mine(p).team && room.state.seats.get(q.id)?.gk);
        if (taken) return;
        seat.gk = true;
      }
      refreshRoles(room);
      placeFormation(room);
    },

    /** Elegir el equipo de tu lado (camiseta y nombre), mientras se espera. No puede ser el mismo que el rival. */
    kit(room, p, data: { k: number }) {
      const g = room.state.game;
      if (g.phase !== Phase.Lobby) return;
      const k = Math.floor(Number(data?.k));
      if (!Number.isFinite(k) || k < 0 || k >= TEAMS.length) return;
      const m = mine(p);
      if (m.team === Team.Red) {
        if (k !== g.kitBlue) g.kitRed = k;
      } else if (k !== g.kitRed) g.kitBlue = k;
    },

    shoot(room, p, data: { a: number; p: number }) {
      const a = Number(data?.a);
      const pw = Number(data?.p);
      if (!Number.isFinite(a)) return;
      doShoot(room, mine(p).entity, a, Number.isFinite(pw) ? pw : 0.5);
    },

    pass(room, p, data: { a: number }) {
      const a = Number(data?.a);
      if (!Number.isFinite(a)) return;
      doPass(room, mine(p).entity, a, false);
    },

    trick(room, p) {
      const g = room.state.game;
      if (g.phase !== Phase.Playing && g.phase !== Phase.Lobby) return;
      doTrick(room, mine(p).entity);
    },

    tackle(room, p) {
      doTackle(room, mine(p).entity);
    },
  },
});
