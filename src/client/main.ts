import { join, platformUser, type RoomClient } from "../net/client";
import {
  AREA_R,
  attackDir,
  BALL_R,
  CIRCLE_R,
  DASH_SPEED,
  FOULS_LIMIT,
  Fx,
  game,
  GOAL_DEPTH,
  GOAL_H,
  GOAL_HALF,
  HALF_L,
  HALF_W,
  KICK_RANGE,
  Phase,
  Rk,
  SPEED,
  SPOT,
  SPOT2,
  SPRINT,
  Team,
} from "../shared";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const TAU = Math.PI * 2;
const COLORS = ["#ff5a36", "#25c5ff"];
const DARK = ["#a8290f", "#0c6f9c"];
/** Camiseta del arquero de cada equipo. */
const GKCOL = ["#f2c230", "#7ee081"];
const TEAM_NAMES = ["Rojo", "Azul"];
const RK_NAMES = ["", "Saque del medio", "Saque de banda", "Tiro de esquina", "Saque de arco", "Tiro libre", "Penal", "Doble penal (10 m)"];
const PAINT = ["#ff4d6d", "#ffd23f", "#3bceac", "#8a6bff"];
const SKINS = ["#f0c9a0", "#d9a77c", "#b07a52", "#7d5338"];
const HAIR = ["#1c1410", "#3b2a1d", "#6b4a2b", "#caa24a"];
const BOARD_H = 1;
const FENCE_TOP = 3.2;
const BZ = HALF_W + 1.4;
/** Cuánto se acerca la cámara a la jugada (si la ventana lo permite). */
const ZOOM = 1.3;

type Room = RoomClient<typeof game.state>;
let room: Room;
const kicks: { x: number; z: number; t: number }[] = [];
const popups: { x: number; z: number; text: string; color: string; t: number }[] = [];
const motion = new Map<number, { x: number; z: number; speed: number; phase: number }>();
let resultAt = 0;
let shakeUntil = 0;
let charging = false;
let chargeStart = 0;
let dashLeft = 0;
let dashYaw = 0;
let stamina = 1;
let lastFrame = 0;

const hash = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

// ── link de la sala ──
const params = new URLSearchParams(location.search);
let roomId = params.get("room") || "";
if (!roomId) {
  roomId = Math.random().toString(36).slice(2, 7);
  params.set("room", roomId);
  history.replaceState(null, "", `?${params}`);
}
const link = `${location.origin}${location.pathname}?room=${roomId}`;
$("link").textContent = link;
$("copy").onclick = () => {
  navigator.clipboard?.writeText(link).then(() => toast("Link copiado"), () => toast(link));
};

// ── entrar ──
try {
  $<HTMLInputElement>("name").value = localStorage.getItem("futsal5-name") ?? "";
} catch {}
// En Fogón se juega con el nombre de la cuenta: entra directo.
const account = platformUser();
if (account) {
  $<HTMLInputElement>("name").value = account.name;
  queueMicrotask(() => $<HTMLFormElement>("joinForm").requestSubmit());
}
$("joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("name").value.trim() || "Jugador";
  try {
    localStorage.setItem("futsal5-name", name);
  } catch {}
  $("joinBox").hidden = true;
  try {
    room = await join(game, { name, room: roomId });
  } catch {
    $("joinBox").hidden = false;
    toast("No se pudo entrar a la sala. Probá de nuevo.");
    return;
  }
  wire();
  useGL = initGL();
  glCv.style.display = useGL ? "block" : "none";
  for (const id of ["top", "sub", "teams", "help", "net"]) $(id).hidden = false;
  requestAnimationFrame(frame);
});

function wire() {
  room.on("kick", (d: { x: number; z: number }) => {
    kicks.push({ x: d.x, z: d.z, t: performance.now() });
  });
  room.on("style", (d: { x: number; z: number; text: string; team: number }) => {
    popups.push({ x: d.x, z: d.z, text: d.text, color: COLORS[d.team % 2], t: performance.now() });
  });
  room.on("goal", (d: { team: number; name: string; own: boolean }) => {
    const who = d.name ? (d.own ? `${d.name} (en contra)` : d.name) : "";
    banner(`¡GOL de ${TEAM_NAMES[d.team]}!`, who, COLORS[d.team], 2800);
    shakeUntil = performance.now() + 450;
  });
  room.on("foul", (d: { team: number; name: string; reason: string; count: number; kind: number }) => {
    toast(`Falta de ${d.name} (${d.reason}) · ${TEAM_NAMES[d.team]} lleva ${d.count}`);
    if (d.kind === Rk.Penalty) banner("¡PENAL!", `Falta de ${d.name} dentro del área`, "#ffd23f", 2200);
    else if (d.kind === Rk.Penalty10) banner("¡DOBLE PENAL!", `Sexta falta de ${TEAM_NAMES[d.team]}: tiro de 10 metros sin barrera`, "#ffd23f", 2600);
  });
  room.on("halftime", (d: { red: number; blue: number }) => {
    banner("Entretiempo", `Rojo ${d.red} - ${d.blue} Azul · se cambian de lado`, "#ffffff", 4500);
  });
  room.on("end", (d: { red: number; blue: number; winner: number; rows: { name: string; team: number; goals: number; fouls: number; card: number }[] }) => {
    $("endTitle").textContent = d.winner === 2 ? "Empate" : `Ganó el equipo ${TEAM_NAMES[d.winner]}`;
    $("endScore").textContent = `${d.red} - ${d.blue}`;
    $("endList").innerHTML = d.rows
      .map((r) => `<li><span style="color:${COLORS[r.team % 2]}">${esc(r.name)}</span><span>⚽ ${r.goals} · faltas ${r.fouls}${r.card === 1 ? " 🟨" : r.card === 2 ? " 🟥" : ""}</span></li>`)
      .join("");
    $("endBox").hidden = false;
    resultAt = performance.now();
  });
  room.on("notice", (d: { text: string }) => toast(d.text));
  room.on("__full", () => toast("La sala está llena"));
  room.on("close", () => toast("Se cortó la conexión. Recargá la página para volver."));
  $("start").onclick = () => room.send("start");
  $("switch").onclick = () => room.send("team");
  $("gk").onclick = () => room.send("gk");
  // Botones para el celu.
  const hold = (id: string, down: () => void, up?: () => void) => {
    const el = $(id);
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      down();
    });
    if (up) {
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      el.addEventListener("pointerleave", up);
    }
  };
  hold("bShot", startCharge, releaseShot);
  hold("bPass", pass);
  hold("bTrick", trick);
  hold("bTackle", tackle);
}

let bannerTimer = 0;
function banner(title: string, text: string, color: string, ms: number) {
  $("bannerTitle").textContent = title;
  $("bannerTitle").style.color = color;
  $("bannerText").textContent = text;
  $("bannerText").hidden = !text;
  $("banner").hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => ($("banner").hidden = true), ms);
}

function toast(text: string) {
  const el = document.createElement("div");
  el.textContent = text;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 3800);
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ── cámara: perspectiva real, inclinada, que sigue la jugada ──
// La usan igual el dibujo 3D (WebGL) y el 2D de respaldo, así los carteles y los nombres calzan con la escena.
const PITCH = (54 * Math.PI) / 180;
const SIN = Math.sin(PITCH);
const COS = Math.cos(PITCH);
const CAM_D = 40;
const CAM_H = CAM_D * SIN;
const CAM_Z = CAM_D * COS;
let FOCAL = 600;
let FOCAL_FULL = 600;
let OFF_X = 0;
let OFF_Y = 0;
let CAM_X = 0;
let PAN_MAX = 0;

function relAt(x: number, h: number, z: number, camX: number) {
  const ry = h - CAM_H;
  const rz = z + CAM_Z;
  const yc = ry * COS + rz * SIN;
  const zc = -ry * SIN + rz * COS;
  return { rx: (x - camX) / zc, ry: -yc / zc, zc };
}
const rel = (x: number, h: number, z: number) => relAt(x, h, z, CAM_X);
/** Punto del mundo (x, altura, z) a pantalla: [X, Y, píxeles por metro a esa distancia]. */
function proj(x: number, h: number, z: number): [number, number, number] {
  const r = rel(x, h, z);
  return [OFF_X + FOCAL * r.rx, OFF_Y + FOCAL * r.ry, FOCAL / r.zc];
}
const P = (x: number, h: number, z: number): [number, number] => {
  const p = proj(x, h, z);
  return [p[0], p[1]];
};
/** De pantalla al piso de la cancha. */
function unproj(px: number, py: number) {
  const rx = (px - OFF_X) / FOCAL;
  const ry = (py - OFF_Y) / FOCAL;
  const t = CAM_H / (ry * COS + SIN);
  return { x: t * rx + CAM_X, z: -CAM_Z + t * (COS - ry * SIN) };
}

/** Encuadra la cancha en la ventana (con un poco de zoom) dejando lugar a los carteles. */
function fitCamera(W: number, H: number) {
  const X = HALF_L + 4;
  const pts: [number, number, number][] = [
    [-X, 0, -(HALF_W + 1.8)],
    [X, 0, -(HALF_W + 1.8)],
    [-X, 0, BZ],
    [X, 0, BZ],
    [-X, FENCE_TOP, BZ],
    [X, FENCE_TOP, BZ],
  ];
  let a = Infinity;
  let b = -Infinity;
  let c = Infinity;
  let d = -Infinity;
  for (const [x, h, z] of pts) {
    const r = relAt(x, h, z, 0);
    a = Math.min(a, r.rx);
    b = Math.max(b, r.rx);
    c = Math.min(c, r.ry);
    d = Math.max(d, r.ry);
  }
  const availW = W * 0.97;
  const availH = Math.max(120, H - 124);
  FOCAL_FULL = Math.min(availW / (b - a), availH / (d - c));
  FOCAL = Math.min((availW / (b - a)) * ZOOM, availH / (d - c));
  OFF_X = W / 2 - (FOCAL * (a + b)) / 2;
  OFF_Y = 70 + availH / 2 - (FOCAL * (c + d)) / 2;
  PAN_MAX = X * Math.max(0, 1 - FOCAL_FULL / FOCAL);
}

// ── controles ──
const keys = new Set<string>();
let mouse = { x: -1e9, y: -1e9 };
let dest: { x: number; z: number } | null = null;
let pressing = false;
const held = (...c: string[]) => (c.some((k) => keys.has(k)) ? 1 : 0);

/** Hacia dónde apuntar: al mouse si está sobre la cancha; si no, hacia donde miro. */
function aim(): number {
  const m = room.mine;
  if (!m) return 0;
  if (mouse.x > -1e8) {
    const w = unproj(mouse.x, mouse.y);
    return Math.atan2(w.z - m.z, w.x - m.x);
  }
  return m.yaw;
}
function startCharge() {
  if (charging || !room?.mine) return;
  charging = true;
  chargeStart = performance.now();
}
function releaseShot() {
  if (!charging) return;
  charging = false;
  const p = Math.min(1, (performance.now() - chargeStart) / 900);
  room.send("shoot", { a: aim(), p: Math.max(0.25, p) });
}
function pass() {
  if (room?.mine) room.send("pass", { a: aim() });
}
function trick() {
  const m = room?.mine;
  if (!m) return;
  // La gambeta incluye un arranque corto hacia donde mirás.
  if (m.has && m.fx === Fx.None && dashLeft <= 0 && room.state.game.phase !== Phase.Restart) {
    dashLeft = 0.32;
    dashYaw = m.yaw;
  }
  room.send("trick");
}
function tackle() {
  if (room?.mine) room.send("tackle");
}

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT" || !room) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) startCharge();
    return;
  }
  if (e.repeat) return;
  if (e.code === "KeyE") pass();
  else if (e.code === "KeyQ" || e.code === "KeyF") trick();
  else if (e.code === "KeyC" || e.code === "KeyX") tackle();
  else keys.add(e.code);
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && room) releaseShot();
  keys.delete(e.code);
});
window.addEventListener("blur", () => {
  keys.clear();
  charging = false;
});

const cv = $<HTMLCanvasElement>("cv");
const glCv = $<HTMLCanvasElement>("gl");
const g = cv.getContext("2d")!;
cv.addEventListener("contextmenu", (e) => e.preventDefault());
cv.addEventListener("pointermove", (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (pressing && e.pointerType !== "mouse") dest = unproj(e.clientX, e.clientY);
});
cv.addEventListener("pointerleave", () => (mouse = { x: -1e9, y: -1e9 }));
cv.addEventListener("pointerdown", (e) => {
  if (!room) return;
  if (e.pointerType === "mouse") {
    mouse = { x: e.clientX, y: e.clientY };
    if (e.button === 2) pass();
    else startCharge();
    return;
  }
  // En el celu: tocar y arrastrar para caminar; los botones hacen el resto.
  mouse = { x: -1e9, y: -1e9 };
  pressing = true;
  dest = unproj(e.clientX, e.clientY);
  cv.setPointerCapture(e.pointerId);
});
window.addEventListener("pointerup", (e) => {
  if (e.pointerType === "mouse" && e.button === 0 && room) releaseShot();
});
const release = () => {
  pressing = false;
  dest = null;
};
cv.addEventListener("pointerup", release);
cv.addEventListener("pointercancel", release);

function update(dt: number) {
  const m = room.mine;
  if (!m) return;
  // Expulsado: espera afuera los 2 minutos.
  if (m.fx === Fx.Out) return;
  let ix = held("KeyD", "ArrowRight") - held("KeyA", "ArrowLeft");
  let iz = held("KeyW", "ArrowUp") - held("KeyS", "ArrowDown");
  if (!ix && !iz && dest) {
    const dx = dest.x - m.x;
    const dz = dest.z - m.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.4) {
      ix = dx / d;
      iz = dz / d;
    }
  }
  const sprint = held("ShiftLeft", "ShiftRight") === 1 && stamina > 0.02 && (ix !== 0 || iz !== 0);
  stamina = sprint ? Math.max(0, stamina - dt * 0.4) : Math.min(1, stamina + dt * 0.25);
  let speed = sprint ? SPRINT : SPEED;
  if (m.fx === Fx.Stun) speed *= 0.35;
  if (dashLeft > 0) {
    dashLeft -= dt;
    ix = Math.cos(dashYaw);
    iz = Math.sin(dashYaw);
    speed = DASH_SPEED;
  }
  if (!ix && !iz) return;
  const l = Math.hypot(ix, iz);
  const x = Math.max(-(HALF_L - 0.4), Math.min(HALF_L - 0.4, m.x + (ix / l) * speed * dt));
  const z = Math.max(-(HALF_W - 0.4), Math.min(HALF_W - 0.4, m.z + (iz / l) * speed * dt));
  room.move({ x, z, yaw: Math.atan2(iz, ix) });
}

// ── 3D: motor WebGL propio (Fogón no deja usar librerías) ──
const VS = `
attribute vec3 aPos;
attribute vec3 aNor;
attribute vec4 aCol;
uniform mat4 uVP;
varying vec3 vN;
varying vec4 vC;
varying float vD;
void main() {
  vec4 p = uVP * vec4(aPos, 1.0);
  gl_Position = p;
  vN = aNor;
  vC = aCol;
  vD = p.w;
}`;
const FS = `
precision mediump float;
uniform vec3 uL;
uniform vec3 uFog;
varying vec3 vN;
varying vec4 vC;
varying float vD;
void main() {
  float lit = step(0.001, dot(vN, vN));
  vec3 n = normalize(vN + (1.0 - lit) * vec3(0.0, 1.0, 0.0));
  float d = max(dot(n, uL), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 col = mix(vC.rgb, vC.rgb * (0.36 + 0.36 * hemi + 0.62 * d), lit);
  float f = clamp((vD - 55.0) / 70.0, 0.0, 0.7);
  col = mix(col, uFog, f);
  gl_FragColor = vec4(col, vC.a);
}`;

type M = number[];
const T = (x: number, y: number, z: number): M => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** Giro sobre el eje vertical: lleva el eje x local hacia (cos a, 0, sin a). */
const RY = (a: number): M => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
};
/** Giro sobre el eje z (el de los costados): sirve para balancear piernas y brazos. */
const RZ = (a: number): M => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
};
function mul(a: M, b: M): M {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

const hexCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let c = hexCache.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    hexCache.set(hex, c);
  }
  return c;
}

/** Lista de vértices: posición (3), normal (3; en cero = sin luz), color (3) y opacidad (1). */
class Buf {
  f = new Float32Array(1 << 16);
  n = 0;
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: [number, number, number], a: number) {
    if ((this.n + 1) * 10 > this.f.length) {
      const nf = new Float32Array(this.f.length * 2);
      nf.set(this.f);
      this.f = nf;
    }
    const i = this.n * 10;
    const f = this.f;
    f[i] = x;
    f[i + 1] = y;
    f[i + 2] = z;
    f[i + 3] = nx;
    f[i + 4] = ny;
    f[i + 5] = nz;
    f[i + 6] = c[0];
    f[i + 7] = c[1];
    f[i + 8] = c[2];
    f[i + 9] = a;
    this.n++;
  }
  clear() {
    this.n = 0;
  }
}

const FACES: { n: [number, number, number]; c: [number, number, number][] }[] = [
  { n: [1, 0, 0], c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];
const IDX = [0, 1, 2, 0, 2, 3];
const TP = new Float64Array(12);

/** Caja de tamaño (sx, sy, sz) centrada en el origen de la matriz m (solo giros y desplazamientos). */
function box(buf: Buf, m: M, sx: number, sy: number, sz: number, col: string, a = 1, lit = true) {
  const c = rgb(col);
  for (let fi = 0; fi < 6; fi++) {
    const f = FACES[fi];
    let nx = 0;
    let ny = 0;
    let nz = 0;
    if (lit) {
      nx = m[0] * f.n[0] + m[4] * f.n[1] + m[8] * f.n[2];
      ny = m[1] * f.n[0] + m[5] * f.n[1] + m[9] * f.n[2];
      nz = m[2] * f.n[0] + m[6] * f.n[1] + m[10] * f.n[2];
    }
    for (let k = 0; k < 4; k++) {
      const x = (f.c[k][0] * sx) / 2;
      const y = (f.c[k][1] * sy) / 2;
      const z = (f.c[k][2] * sz) / 2;
      TP[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      TP[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      TP[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    for (const k of IDX) buf.v(TP[k * 3], TP[k * 3 + 1], TP[k * 3 + 2], nx, ny, nz, c, a);
  }
}
function boxAt(buf: Buf, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: string, a = 1, lit = true) {
  box(buf, T(cx, cy, cz), sx, sy, sz, col, a, lit);
}
/** Rectángulo plano sobre el piso. */
function flat(buf: Buf, x1: number, z1: number, x2: number, z2: number, y: number, col: string, a = 1) {
  const c = rgb(col);
  buf.v(x1, y, z1, 0, 1, 0, c, a);
  buf.v(x2, y, z1, 0, 1, 0, c, a);
  buf.v(x2, y, z2, 0, 1, 0, c, a);
  buf.v(x1, y, z1, 0, 1, 0, c, a);
  buf.v(x2, y, z2, 0, 1, 0, c, a);
  buf.v(x1, y, z2, 0, 1, 0, c, a);
}
/** Polígono convexo plano sobre el piso. */
function flatPoly(buf: Buf, pts: [number, number][], y: number, col: string, a = 1) {
  const c = rgb(col);
  for (let i = 1; i < pts.length - 1; i++) {
    buf.v(pts[0][0], y, pts[0][1], 0, 1, 0, c, a);
    buf.v(pts[i][0], y, pts[i][1], 0, 1, 0, c, a);
    buf.v(pts[i + 1][0], y, pts[i + 1][1], 0, 1, 0, c, a);
  }
}
/** Línea con ancho, pintada sobre el piso. */
function segLine(buf: Buf, x1: number, z1: number, x2: number, z2: number, w: number, y: number, col: string, a = 1) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const l = Math.hypot(dx, dz) || 1;
  const px = ((-dz / l) * w) / 2;
  const pz = ((dx / l) * w) / 2;
  const c = rgb(col);
  const A: [number, number] = [x1 + px, z1 + pz];
  const B: [number, number] = [x1 - px, z1 - pz];
  const C: [number, number] = [x2 - px, z2 - pz];
  const D_: [number, number] = [x2 + px, z2 + pz];
  for (const q of [A, B, C, A, C, D_]) buf.v(q[0], y, q[1], 0, 1, 0, c, a);
}
function circlePts(cx: number, cz: number, r: number, n = 24): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([cx + Math.cos((i / n) * TAU) * r, cz + Math.sin((i / n) * TAU) * r]);
  return pts;
}
/** Cuadrado vertical con un degradé (para el cielo del fondo), sin luz. */
function gradQuad(buf: Buf, p: [number, number, number][], cols: string[]) {
  for (const k of IDX) buf.v(p[k][0], p[k][1], p[k][2], 0, 0, 0, rgb(cols[k]), 1);
}
function sphere(buf: Buf, cx: number, cy: number, cz: number, r: number, col: (i: number, j: number) => string, nLat: number, nLon: number) {
  const pt = (t: number, p: number): [number, number, number] => [Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)];
  for (let i = 0; i < nLat; i++) {
    const t0 = (i / nLat) * Math.PI;
    const t1 = ((i + 1) / nLat) * Math.PI;
    for (let j = 0; j < nLon; j++) {
      const p0 = (j / nLon) * TAU;
      const p1 = ((j + 1) / nLon) * TAU;
      const c = rgb(col(i, j));
      const A = pt(t0, p0);
      const B = pt(t0, p1);
      const C = pt(t1, p1);
      const D_ = pt(t1, p0);
      for (const q of [A, B, C, A, C, D_]) buf.v(cx + q[0] * r, cy + q[1] * r, cz + q[2] * r, q[0], q[1], q[2], c, 1);
    }
  }
}

let gl: WebGLRenderingContext | null = null;
let useGL = false;
let uVP: WebGLUniformLocation | null = null;
let uL: WebGLUniformLocation | null = null;
let uFog: WebGLUniformLocation | null = null;
let aPos = 0;
let aNor = 0;
let aCol = 0;
let bufO: WebGLBuffer | null = null;
let bufF: WebGLBuffer | null = null;
let bufG: WebGLBuffer | null = null;
let bufS: WebGLBuffer | null = null;
let bufD: WebGLBuffer | null = null;
let nO = 0;
let nF = 0;
let nG = 0;
let staticHalf = -1;
const SB = new Buf();
const DB = new Buf();

function compileShader(type: number, src: string): WebGLShader {
  const G = gl!;
  const s = G.createShader(type)!;
  G.shaderSource(s, src);
  G.compileShader(s);
  if (!G.getShaderParameter(s, G.COMPILE_STATUS)) throw new Error(G.getShaderInfoLog(s) ?? "shader");
  return s;
}

/** Prepara WebGL. Devuelve false si el dispositivo no puede: entonces se juega con el dibujo 2.5D de respaldo. */
function initGL(): boolean {
  try {
    gl = glCv.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) return false;
    const p = gl.createProgram()!;
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return false;
    gl.useProgram(p);
    uVP = gl.getUniformLocation(p, "uVP");
    uL = gl.getUniformLocation(p, "uL");
    uFog = gl.getUniformLocation(p, "uFog");
    aPos = gl.getAttribLocation(p, "aPos");
    aNor = gl.getAttribLocation(p, "aNor");
    aCol = gl.getAttribLocation(p, "aCol");
    bufO = gl.createBuffer();
    bufF = gl.createBuffer();
    bufG = gl.createBuffer();
    bufS = gl.createBuffer();
    bufD = gl.createBuffer();
    staticHalf = -1;
    return true;
  } catch {
    gl = null;
    return false;
  }
}
function disableGL() {
  useGL = false;
  glCv.style.display = "none";
  toast("No se pudo usar el 3D en este dispositivo: se juega en 2.5D");
}

/** El equipo que defiende el arco que está en x = sign * HALF_L (cambia en el segundo tiempo). */
function defenderOf(sign: number, half: number): number {
  return attackDir(Team.Red, half) === -sign ? Team.Red : Team.Blue;
}

/** Todo lo que no se mueve: cancha, líneas, carteles, alambrado, arcos, postes de luz y edificios. */
function buildStatic(half: number) {
  const O = new Buf();
  const F = new Buf();
  const G = new Buf();
  const X = HALF_L + 4;
  // Fondo: cielo, calle y vereda.
  gradQuad(O, [[-300, 0, BZ + 120], [300, 0, BZ + 120], [300, 50, BZ + 120], [-300, 50, BZ + 120]], ["#3d2547", "#3d2547", "#0c0a1a", "#0c0a1a"]);
  flat(O, -300, -50, 300, 220, -0.03, "#14151c");
  flat(O, -(HALF_L + 9), -(HALF_W + 5), HALF_L + 9, BZ + 2.5, -0.015, "#1b1d26");
  // La cancha con sus baldosas.
  flat(O, -HALF_L, -HALF_W, HALF_L, HALF_W, 0, "#3a3d4a");
  for (let x = -HALF_L + 2.5; x < HALF_L; x += 2.5) segLine(O, x, -HALF_W, x, HALF_W, 0.04, 0.004, "#454959");
  for (let z = -HALF_W + 2.5; z < HALF_W; z += 2.5) segLine(O, -HALF_L, z, HALF_L, z, 0.04, 0.004, "#454959");
  // Pozos de luz de los postes.
  for (const [lx, lz] of [
    [-HALF_L * 0.55, HALF_W * 0.5],
    [HALF_L * 0.55, HALF_W * 0.5],
    [-HALF_L * 0.55, -HALF_W * 0.5],
    [HALF_L * 0.55, -HALF_W * 0.5],
  ]) flatPoly(F, circlePts(lx, lz, 9, 24), 0.007, "#ffe2a0", 0.06);
  // Áreas penales (cuarto de círculo de 6 m desde cada palo), pintadas del color de quien defiende.
  const W_ = "#eeeef2";
  for (const sign of [-1, 1]) {
    const pts: [number, number][] = [];
    const gx = sign * HALF_L;
    for (let i = 0; i <= 12; i++) {
      const t = (i / 12) * (Math.PI / 2);
      pts.push([gx - sign * AREA_R * Math.sin(t), -GOAL_HALF - AREA_R * Math.cos(t)]);
    }
    for (let i = 0; i <= 12; i++) {
      const t = (i / 12) * (Math.PI / 2);
      pts.push([gx - sign * AREA_R * Math.cos(t), GOAL_HALF + AREA_R * Math.sin(t)]);
    }
    flatPoly(F, pts, 0.009, COLORS[defenderOf(sign, half)], 0.26);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      segLine(O, a[0], a[1], b[0], b[1], 0.1, 0.012, W_);
    }
    flatPoly(O, circlePts(sign * (HALF_L - SPOT), 0, 0.15, 10), 0.014, W_);
    flatPoly(O, circlePts(sign * (HALF_L - SPOT2), 0, 0.15, 10), 0.014, W_);
  }
  // Bordes, línea del medio y círculo central.
  segLine(O, -HALF_L, -HALF_W, HALF_L, -HALF_W, 0.12, 0.012, W_);
  segLine(O, -HALF_L, HALF_W, HALF_L, HALF_W, 0.12, 0.012, W_);
  segLine(O, -HALF_L, -HALF_W, -HALF_L, HALF_W, 0.12, 0.012, W_);
  segLine(O, HALF_L, -HALF_W, HALF_L, HALF_W, 0.12, 0.012, W_);
  segLine(O, 0, -HALF_W, 0, HALF_W, 0.1, 0.012, W_);
  const cc = circlePts(0, 0, CIRCLE_R, 40);
  for (let i = 0; i < cc.length; i++) {
    const a = cc[i];
    const b = cc[(i + 1) % cc.length];
    segLine(O, a[0], a[1], b[0], b[1], 0.1, 0.012, W_);
  }
  flatPoly(O, circlePts(0, 0, 0.15, 10), 0.014, W_);

  // Carteles bajos con graffiti, alambrado alto atrás y carteles detrás de cada arco.
  boxAt(O, 0, BOARD_H / 2, BZ + 0.1, X * 2, BOARD_H, 0.2, "#2a2e3d");
  boxAt(O, 0, BOARD_H + 0.05, BZ + 0.1, X * 2, 0.1, 0.3, "#4a5068");
  for (let i = 0; i < 20; i++) {
    const x0 = -X + 0.4 + i * 2.3;
    const w = 1.2 + ((i * 5) % 3) * 0.4;
    const h = 0.35 + ((i * 7) % 4) * 0.15;
    boxAt(O, x0 + w / 2, 0.1 + h / 2, BZ - 0.01, w, h, 0.04, PAINT[i % 4]);
  }
  for (let x = -X; x <= X; x += 6) boxAt(O, x, FENCE_TOP / 2, BZ + 0.1, 0.14, FENCE_TOP, 0.14, "#4a5068");
  boxAt(O, 0, FENCE_TOP, BZ + 0.1, X * 2, 0.1, 0.12, "#4a5068");
  for (const sign of [-1, 1]) {
    const x = sign * (HALF_L + GOAL_DEPTH + 1.2);
    boxAt(O, x, BOARD_H / 2, 0, 0.2, BOARD_H, BZ * 2, "#2a2e3d");
    boxAt(O, x, BOARD_H + 0.05, 0, 0.3, 0.1, BZ * 2, "#4a5068");
    for (let i = 0; i < 7; i++) {
      const z0 = -BZ + 0.6 + i * 3.1;
      boxAt(O, x - sign * 0.11, 0.35, z0 + 0.9, 0.04, 0.5, 1.8, PAINT[(i + (sign > 0 ? 2 : 0)) % 4]);
    }
  }
  // Vidrio del alambrado y cartel del frente (transparentes, van al final).
  flat(G, 0, 0, 0, 0, 0, "#000000", 0);
  boxAt(G, 0, (FENCE_TOP + BOARD_H) / 2, BZ + 0.1, X * 2, FENCE_TOP - BOARD_H, 0.03, "#9fb0ff", 0.1);
  boxAt(G, 0, 0.25, -(HALF_W + 1.4), X * 2, 0.5, 0.15, "#161822", 0.5);
  boxAt(G, 0, 0.55, -(HALF_W + 1.4), X * 2, 0.1, 0.2, "#5a617c", 0.7);

  // Arcos de 3 x 2 m con red.
  for (const sign of [-1, 1]) {
    const col = COLORS[defenderOf(sign, half)];
    const x1 = sign * HALF_L;
    const x2 = sign * (HALF_L + GOAL_DEPTH);
    flat(O, Math.min(x1, x2), -GOAL_HALF, Math.max(x1, x2), GOAL_HALF, 0.003, "#0d0f15");
    boxAt(O, x1, GOAL_H / 2, -GOAL_HALF, 0.12, GOAL_H, 0.12, col);
    boxAt(O, x1, GOAL_H / 2, GOAL_HALF, 0.12, GOAL_H, 0.12, col);
    boxAt(O, x1, GOAL_H, 0, 0.12, 0.12, GOAL_HALF * 2 + 0.12, col);
    boxAt(O, x2, GOAL_H / 2, 0, 0.05, GOAL_H, GOAL_HALF * 2, "#e8ecff", 0.22);
    boxAt(O, (x1 + x2) / 2, GOAL_H / 2, -GOAL_HALF, GOAL_DEPTH, GOAL_H, 0.04, "#e8ecff", 0.14);
    boxAt(O, (x1 + x2) / 2, GOAL_H / 2, GOAL_HALF, GOAL_DEPTH, GOAL_H, 0.04, "#e8ecff", 0.14);
    boxAt(O, (x1 + x2) / 2, GOAL_H, 0, GOAL_DEPTH, 0.04, GOAL_HALF * 2, "#e8ecff", 0.14);
  }
  // Postes de luz en las cuatro esquinas.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * (HALF_L + 3);
      const pz = sz > 0 ? BZ + 0.8 : -(HALF_W + 2);
      boxAt(O, px, 2.7, pz, 0.22, 5.4, 0.22, "#2a2d3a");
      boxAt(O, px, 5.5, pz, 0.9, 0.18, 0.9, "#fff0c4", 1, false);
    }
  }
  // Edificios de fondo con ventanas encendidas.
  const shades = ["#17132b", "#1d1733", "#201a38"];
  for (let i = 0; i < 30; i++) {
    const w = 6 + ((i * 13) % 6);
    const h = 7 + ((i * 29) % 17);
    const x = -150 + i * 10.2 + ((i * 7) % 3);
    const z = BZ + 12 + ((i * 7) % 5) * 6;
    boxAt(O, x, h / 2, z, w, h, w * 0.8, shades[i % 3]);
    for (let wy = 1.5; wy < h - 0.8; wy += 2.2) {
      for (let wx = x - w / 2 + 0.9; wx < x + w / 2 - 0.5; wx += 1.6) {
        if ((Math.floor(wx * 7 + wy * 13) + i) % 5 < 2) boxAt(O, wx, wy, z - w * 0.4 - 0.03, 0.7, 0.9, 0.05, "#ffd678", 1, false);
      }
    }
  }
  return { O, F, G };
}

function upload(buf: WebGLBuffer | null, b: Buf, dynamic: boolean) {
  const G = gl!;
  G.bindBuffer(G.ARRAY_BUFFER, buf);
  G.bufferData(G.ARRAY_BUFFER, b.f.subarray(0, b.n * 10), dynamic ? G.DYNAMIC_DRAW : G.STATIC_DRAW);
}
function drawBuf(buf: WebGLBuffer | null, n: number, depthWrite: boolean) {
  if (!n) return;
  const G = gl!;
  G.depthMask(depthWrite);
  G.bindBuffer(G.ARRAY_BUFFER, buf);
  G.enableVertexAttribArray(aPos);
  G.enableVertexAttribArray(aNor);
  G.enableVertexAttribArray(aCol);
  G.vertexAttribPointer(aPos, 3, G.FLOAT, false, 40, 0);
  G.vertexAttribPointer(aNor, 3, G.FLOAT, false, 40, 12);
  G.vertexAttribPointer(aCol, 4, G.FLOAT, false, 40, 24);
  G.drawArrays(G.TRIANGLES, 0, n);
}

/** Matriz que reproduce exactamente la cámara de proj(): lo que dibuja el 3D calza con los nombres y carteles. */
function vpMatrix(W: number, H: number): Float32Array {
  const a = FOCAL / (W / 2);
  const b = (OFF_X - W / 2) / (W / 2);
  const c = FOCAL / (H / 2);
  const d = -(OFF_Y - H / 2) / (H / 2);
  const n = 1;
  const f = 300;
  const A = (f + n) / (f - n);
  const B = (-2 * f * n) / (f - n);
  const D_ = CAM_D;
  return new Float32Array([
    a, 0, 0, 0,
    -b * SIN, c * COS - d * SIN, -A * SIN, -SIN,
    b * COS, c * SIN + d * COS, A * COS, COS,
    b * D_ - a * CAM_X, d * D_, A * D_ + B, D_,
  ]);
}

interface Pl {
  x: number;
  z: number;
  yaw: number;
  team: number;
  bot: boolean;
  name: string;
  fx: number;
  has: boolean;
  gk: boolean;
  card: number;
  mine: boolean;
}

function shadow(x: number, z: number, r: number, a: number) {
  flatPoly(SB, circlePts(x, z, r, 12), 0.02, "#000000", a);
}

/** Un jugador en 3D: piernas, short, remera, brazos y cabeza que se mueven al caminar. */
function buildCharacter(id: number, p: Pl, now: number) {
  const st = motion.get(id);
  const moving = Math.min(1, (st?.speed ?? 0) / 2.5);
  const phase = st?.phase ?? 0;
  const trick = p.fx === Fx.Trick;
  const hop = trick ? Math.abs(Math.sin(now / 110)) * 0.45 : 0;
  const spin = trick ? now / 90 : 0;
  const t = p.team % 2;
  const shirt = p.gk ? GKCOL[t] : COLORS[t];
  const skin = SKINS[hash(p.name) % SKINS.length];
  const hair = HAIR[(hash(p.name) >> 3) % HAIR.length];
  const root = mul(T(p.x, hop, p.z), RY(p.yaw + spin));
  const at = (x: number, y: number, z: number) => mul(root, T(x, y, z));
  const sw = Math.sin(phase * 2) * 0.85 * moving;
  shadow(p.x, p.z, 0.55, 0.38);
  for (const side of [-1, 1]) {
    const leg = mul(at(0, 0.86, side * 0.12), RZ(side * sw));
    box(DB, mul(leg, T(0, -0.38, 0)), 0.16, 0.76, 0.16, skin);
    box(DB, mul(leg, T(0, -0.3, 0)), 0.18, 0.3, 0.18, "#f1f1f1");
    box(DB, mul(leg, T(0.06, -0.74, 0)), 0.3, 0.12, 0.17, "#f4f4f4");
    box(DB, mul(leg, T(0.06, -0.7, 0)), 0.31, 0.03, 0.18, COLORS[t]);
  }
  box(DB, at(0, 0.9, 0), 0.32, 0.32, 0.54, DARK[t]);
  box(DB, at(0, 1.2, 0), 0.3, 0.6, 0.5, shirt);
  for (const side of [-1, 1]) {
    const arm = mul(at(0, 1.42, side * 0.34), RZ(-side * sw * 0.9));
    box(DB, mul(arm, T(0, -0.27, 0)), 0.13, 0.54, 0.13, skin);
    box(DB, mul(arm, T(0, -0.1, 0)), 0.17, 0.22, 0.17, shirt);
    if (p.gk) box(DB, mul(arm, T(0, -0.56, 0)), 0.17, 0.16, 0.17, "#f2f2f2");
  }
  sphere(DB, p.x, 1.7 + hop, p.z, 0.2, () => skin, 5, 8);
  box(DB, at(0, 1.9, 0), 0.4, 0.1, 0.4, hair);
  box(DB, at(0, 1.77, 0), 0.43, 0.05, 0.43, COLORS[t]);
  box(DB, at(0.2, 1.68, 0), 0.06, 0.07, 0.07, "#c98f6a");
}

function buildBall(b: { x: number; z: number; h: number }, now: number) {
  const r = BALL_R * 1.15;
  const off = Math.floor(((b.x + b.z) * 1.4 + now / 4000) * 3);
  shadow(b.x, b.z, r * (1 - Math.min(0.5, b.h * 0.1)) * 1.1, 0.4);
  sphere(DB, b.x, BALL_R + b.h, b.z, r, (i, j) => ((((i + j + off) % 3) + 3) % 3 === 0 ? "#262626" : "#fbfaf5"), 8, 12);
}

function renderGL(now: number, W: number, H: number) {
  const G = gl!;
  const half = room.state.game.half || 1;
  if (half !== staticHalf) {
    const s = buildStatic(half);
    upload(bufO, s.O, false);
    upload(bufF, s.F, false);
    upload(bufG, s.G, false);
    nO = s.O.n;
    nF = s.F.n;
    nG = s.G.n;
    staticHalf = half;
  }
  SB.clear();
  DB.clear();
  for (const id of room.state.people.keys()) {
    const p = room.view("people", id);
    if (p) buildCharacter(id, p, now);
  }
  const b = room.view("ball", 0);
  if (b) buildBall(b, now);
  upload(bufS, SB, true);
  upload(bufD, DB, true);

  G.viewport(0, 0, glCv.width, glCv.height);
  G.clearColor(0.05, 0.05, 0.08, 1);
  G.clear(G.COLOR_BUFFER_BIT | G.DEPTH_BUFFER_BIT);
  G.useProgram(G.getParameter(G.CURRENT_PROGRAM));
  G.enable(G.DEPTH_TEST);
  G.depthFunc(G.LEQUAL);
  G.enable(G.BLEND);
  G.blendFunc(G.SRC_ALPHA, G.ONE_MINUS_SRC_ALPHA);
  G.uniformMatrix4fv(uVP, false, vpMatrix(W, H));
  G.uniform3f(uL, -0.3, 0.85, -0.42);
  G.uniform3f(uFog, 0.08, 0.06, 0.12);
  drawBuf(bufO, nO, true);
  drawBuf(bufF, nF, false);
  drawBuf(bufS, SB.n, false);
  drawBuf(bufD, DB.n, true);
  drawBuf(bufG, nG, false);
}

// ── dibujo 2D: el modo de respaldo y, en modo 3D, los nombres, carteles y marcas encima ──
type Pt = [number, number];
function poly(pts: Pt[], fill?: string | CanvasGradient, stroke?: string, lw = 1) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = lw;
    g.stroke();
  }
}
function line(a: Pt, b: Pt) {
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.stroke();
}
const wallQuad = (x1: number, z1: number, x2: number, z2: number, h0: number, h1: number): Pt[] => [P(x1, h0, z1), P(x2, h0, z2), P(x2, h1, z2), P(x1, h1, z1)];
function ring(x: number, z: number, r: number, color: string, lw: number) {
  g.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * TAU;
    const p = P(x + Math.cos(a) * r, 0, z + Math.sin(a) * r);
    if (i) g.lineTo(p[0], p[1]);
    else g.moveTo(p[0], p[1]);
  }
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.stroke();
}
function dot(x: number, z: number, r: number, color: string) {
  const [X, Y, k] = proj(x, 0, z);
  g.fillStyle = color;
  g.beginPath();
  g.ellipse(X, Y, k * r, k * r * 0.5, 0, 0, TAU);
  g.fill();
}

/** El equipo que defiende el arco que está en x = sign * HALF_L (cambia en el segundo tiempo). */
function defender(sign: number): number {
  return defenderOf(sign, room.state.game.half || 1);
}

function sky(W: number, H: number) {
  const gr = g.createLinearGradient(0, 0, 0, H * 0.6);
  gr.addColorStop(0, "#120f24");
  gr.addColorStop(1, "#3d2547");
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  const base = P(0, FENCE_TOP, BZ)[1];
  const k = FOCAL / 700 + 0.4;
  let x = -10;
  for (let i = 0; x < W; i++) {
    const w = 36 + ((i * 37) % 50);
    const h = (30 + ((i * 53) % 90)) * k;
    g.fillStyle = i % 2 ? "#17132b" : "#1d1733";
    g.fillRect(x, base - h, w, h + 2);
    g.fillStyle = "rgba(255,214,120,.55)";
    for (let wy = base - h + 8; wy < base - 8; wy += 14) {
      for (let wx = x + 6; wx < x + w - 8; wx += 12) {
        if ((Math.floor(wx * 7 + wy * 13) + i) % 5 < 2) g.fillRect(wx, wy, 4, 6);
      }
    }
    x += w + 2;
  }
  g.fillStyle = "#14151c";
  g.fillRect(0, base, W, H - base);
}

/** El área penal: cuarto de círculo de 6 m desde cada palo y recta en el medio. */
function area(sign: number, col: string) {
  const pts: Pt[] = [];
  const gx = sign * HALF_L;
  for (let i = 0; i <= 12; i++) {
    const t = (i / 12) * (Math.PI / 2);
    pts.push(P(gx - sign * AREA_R * Math.sin(t), 0, -GOAL_HALF - AREA_R * Math.cos(t)));
  }
  for (let i = 0; i <= 12; i++) {
    const t = (i / 12) * (Math.PI / 2);
    pts.push(P(gx - sign * AREA_R * Math.cos(t), 0, GOAL_HALF + AREA_R * Math.sin(t)));
  }
  g.globalAlpha = 0.2;
  poly(pts, col);
  g.globalAlpha = 1;
  poly(pts, undefined, "rgba(255,255,255,.85)", 3);
}

function floor2d() {
  poly([P(-HALF_L - 6, 0, -HALF_W - 4), P(HALF_L + 6, 0, -HALF_W - 4), P(HALF_L + 6, 0, BZ + 0.5), P(-HALF_L - 6, 0, BZ + 0.5)], "#1b1d26");
  const court = [P(-HALF_L, 0, HALF_W), P(HALF_L, 0, HALF_W), P(HALF_L, 0, -HALF_W), P(-HALF_L, 0, -HALF_W)];
  poly(court, "#3a3d4a");
  g.strokeStyle = "rgba(255,255,255,.05)";
  g.lineWidth = 1;
  for (let x = -HALF_L; x <= HALF_L; x += 2.5) line(P(x, 0, -HALF_W), P(x, 0, HALF_W));
  for (let z = -HALF_W; z <= HALF_W; z += 2.5) line(P(-HALF_L, 0, z), P(HALF_L, 0, z));
  for (const sign of [-1, 1]) {
    area(sign, COLORS[defender(sign)]);
    dot(sign * (HALF_L - SPOT), 0, 0.14, "rgba(255,255,255,.9)");
    dot(sign * (HALF_L - SPOT2), 0, 0.14, "rgba(255,255,255,.9)");
  }
  g.strokeStyle = "rgba(255,255,255,.85)";
  g.lineWidth = 3;
  line(P(0, 0, -HALF_W), P(0, 0, HALF_W));
  ring(0, 0, CIRCLE_R, "rgba(255,255,255,.85)", 3);
  dot(0, 0, 0.14, "rgba(255,255,255,.9)");
  poly(court, undefined, "rgba(255,255,255,.9)", 3);
}

function boards2d() {
  const X = HALF_L + 4;
  poly(wallQuad(-X, BZ, X, BZ, 0, BOARD_H), "#2a2e3d");
  g.globalAlpha = 0.65;
  for (let i = 0; i < 20; i++) {
    const x0 = -X + 0.4 + i * 2.3;
    const w = 1.2 + ((i * 5) % 3) * 0.4;
    poly(wallQuad(x0, BZ, x0 + w, BZ, 0.1, 0.45 + ((i * 7) % 4) * 0.14), PAINT[i % 4]);
  }
  g.globalAlpha = 1;
  poly(wallQuad(-X, BZ, X, BZ, BOARD_H, BOARD_H + 0.1), "#4a5068");
  g.strokeStyle = "rgba(255,255,255,.10)";
  g.lineWidth = 1;
  for (let x = -X; x < X; x += 1.4) {
    line(P(x, BOARD_H + 0.1, BZ), P(x + 1.4, FENCE_TOP, BZ));
    line(P(x + 1.4, BOARD_H + 0.1, BZ), P(x, FENCE_TOP, BZ));
  }
  g.strokeStyle = "#4a5068";
  g.lineWidth = 2;
  line(P(-X, FENCE_TOP, BZ), P(X, FENCE_TOP, BZ));
  for (let x = -X; x <= X; x += 6) line(P(x, 0, BZ), P(x, FENCE_TOP, BZ));
  for (const sign of [-1, 1]) {
    const x = sign * (HALF_L + GOAL_DEPTH + 1.2);
    poly(wallQuad(x, -BZ, x, BZ, 0, BOARD_H), "#2a2e3d");
    g.globalAlpha = 0.6;
    for (let i = 0; i < 7; i++) {
      const a = -BZ + 0.4 + i * 3.1;
      poly(wallQuad(x, a, x, a + 1.8, 0.1, 0.55), PAINT[(i + (sign > 0 ? 2 : 0)) % 4]);
    }
    g.globalAlpha = 1;
    poly(wallQuad(x, -BZ, x, BZ, BOARD_H, BOARD_H + 0.1), "#4a5068");
  }
}

function goals2d() {
  for (const sign of [-1, 1]) {
    const col = COLORS[defender(sign)];
    const x1 = sign * HALF_L;
    const x2 = sign * (HALF_L + GOAL_DEPTH);
    poly([P(x1, 0, -GOAL_HALF), P(x2, 0, -GOAL_HALF), P(x2, 0, GOAL_HALF), P(x1, 0, GOAL_HALF)], "#0d0f15");
    poly(wallQuad(x2, -GOAL_HALF, x2, GOAL_HALF, 0, GOAL_H), "rgba(8,10,14,.92)");
    g.strokeStyle = "rgba(255,255,255,.22)";
    g.lineWidth = 1;
    for (let i = 0; i <= 6; i++) {
      const z = -GOAL_HALF + (i / 6) * GOAL_HALF * 2;
      line(P(x2, 0, z), P(x2, GOAL_H, z));
    }
    for (let i = 0; i <= 5; i++) line(P(x2, (i / 5) * GOAL_H, -GOAL_HALF), P(x2, (i / 5) * GOAL_H, GOAL_HALF));
    g.strokeStyle = col;
    g.lineWidth = Math.max(3, proj(x1, 0, 0)[2] * 0.14);
    g.lineCap = "round";
    line(P(x1, 0, -GOAL_HALF), P(x1, GOAL_H, -GOAL_HALF));
    line(P(x1, 0, GOAL_HALF), P(x1, GOAL_H, GOAL_HALF));
    line(P(x1, GOAL_H, -GOAL_HALF), P(x1, GOAL_H, GOAL_HALF));
    g.lineCap = "butt";
  }
}

function frontBoard2d() {
  const X = HALF_L + 4;
  const z = -(HALF_W + 1.4);
  poly(wallQuad(-X, z, X, z, 0, 0.5), "rgba(22,24,34,.5)");
  poly(wallQuad(-X, z, X, z, 0.5, 0.6), "#5a617c");
}

/** Nombre, tarjeta, marca de "SACA" y estrellitas de un jugador: se dibuja siempre en 2D, encima de la escena. */
function label(p: Pl, now: number, taking: boolean) {
  const [X, Y, u] = proj(p.x, 0, p.z);
  const trick = p.fx === Fx.Trick;
  const hop = trick ? Math.abs(Math.sin(now / 110)) * 0.45 * u : 0;
  if (p.fx === Fx.Out) g.globalAlpha = 0.5;
  if (useGL && p.mine) {
    g.strokeStyle = "#ffe34d";
    g.lineWidth = 2.5;
    g.beginPath();
    g.ellipse(X, Y, u * 0.82, u * 0.36, 0, 0, TAU);
    g.stroke();
  }
  if (p.fx === Fx.Stun) {
    g.fillStyle = "#ffe34d";
    for (let i = 0; i < 3; i++) {
      const a = now / 180 + (i * TAU) / 3;
      g.beginPath();
      g.arc(X + Math.cos(a) * 0.32 * u, Y - 2.1 * u + Math.sin(a) * 0.08 * u, Math.max(2, u * 0.06), 0, TAU);
      g.fill();
    }
  }
  const fs = Math.max(11, u * 0.4);
  g.font = `700 ${fs}px "Nunito Sans", sans-serif`;
  g.textAlign = "center";
  g.lineWidth = 3;
  g.strokeStyle = "rgba(0,0,0,.7)";
  const text = p.mine ? "vos" : p.name;
  const ly = Y - hop - u * 2.25;
  g.strokeText(text, X, ly);
  g.fillStyle = p.mine ? "#ffe34d" : "#ffffff";
  g.fillText(text, X, ly);
  if (p.card > 0) {
    g.fillStyle = p.card === 1 ? "#ffd400" : "#e01e1e";
    g.fillRect(X + g.measureText(text).width / 2 + 4, ly - fs * 0.8, fs * 0.55, fs * 0.8);
  }
  if (taking) {
    const b = Math.sin(now / 160) * 3;
    g.font = `800 ${Math.max(12, u * 0.45)}px "Sora", sans-serif`;
    g.strokeText("▼ SACA", X, ly - fs - 2 + b);
    g.fillStyle = "#ffe34d";
    g.fillText("▼ SACA", X, ly - fs - 2 + b);
  }
  g.globalAlpha = 1;
}

/** Jugador dibujado en 2D (solo en el modo de respaldo). */
function character2d(id: number, p: Pl, now: number) {
  const [X, Y, u] = proj(p.x, 0, p.z);
  const st = motion.get(id);
  const moving = Math.min(1, (st?.speed ?? 0) / 2.5);
  const phase = st?.phase ?? 0;
  const trick = p.fx === Fx.Trick;
  const dx = Math.cos(p.yaw);
  const dz = Math.sin(p.yaw);
  const view = Math.abs(dz) > Math.abs(dx) * 1.15 ? (dz > 0 ? "away" : "toward") : "side";
  const flip = dx < 0 ? -1 : 1;
  const t = p.team % 2;
  const shirt = p.gk ? GKCOL[t] : COLORS[t];
  const skin = SKINS[hash(p.name) % SKINS.length];
  const hair = HAIR[(hash(p.name) >> 3) % HAIR.length];
  if (p.fx === Fx.Out) g.globalAlpha = 0.5;
  g.fillStyle = "rgba(0,0,0,.38)";
  g.beginPath();
  g.ellipse(X, Y, u * 0.55, u * 0.24, 0, 0, TAU);
  g.fill();
  if (p.mine) {
    g.strokeStyle = "#ffe34d";
    g.lineWidth = 2.5;
    g.beginPath();
    g.ellipse(X, Y, u * 0.82, u * 0.36, 0, 0, TAU);
    g.stroke();
  }
  const hop = trick ? Math.abs(Math.sin(now / 110)) * 0.45 * u : 0;
  g.save();
  g.translate(X, Y - hop);
  if (trick) g.scale(Math.max(0.12, Math.abs(Math.cos(now / 70))), 1);
  if (view === "side") g.scale(flip, 1);
  const sw = Math.sin(phase * 2) * 0.3 * u * moving;
  const lift = (s: number) => Math.max(0, s) * 0.13 * u * moving;
  const sneaker = (x: number, y: number) => {
    g.fillStyle = "#f4f4f4";
    g.beginPath();
    g.ellipse(x + (view === "side" ? 0.05 * u : 0), y - 0.07 * u, 0.18 * u, 0.09 * u, 0, 0, TAU);
    g.fill();
    g.fillStyle = COLORS[t];
    g.fillRect(x - 0.1 * u, y - 0.1 * u, 0.2 * u, 0.035 * u);
  };
  const legAt = (x: number, l: number) => {
    g.fillStyle = skin;
    g.fillRect(x - 0.075 * u, -0.6 * u - l, 0.15 * u, 0.46 * u);
    g.fillStyle = "#f1f1f1";
    g.fillRect(x - 0.08 * u, -0.34 * u - l, 0.16 * u, 0.22 * u);
    sneaker(x, -l);
  };
  if (view === "side") {
    legAt(-sw, lift(-Math.sin(phase * 2)));
    legAt(sw, lift(Math.sin(phase * 2)));
  } else {
    legAt(-0.13 * u, lift(Math.sin(phase * 2)));
    legAt(0.13 * u, lift(-Math.sin(phase * 2)));
  }
  g.fillStyle = DARK[t];
  g.beginPath();
  g.roundRect(-0.26 * u, -0.92 * u, 0.52 * u, 0.34 * u, 0.07 * u);
  g.fill();
  const arm = (x: number, l: number) => {
    g.fillStyle = skin;
    g.fillRect(x - 0.065 * u, -1.38 * u + l, 0.13 * u, 0.5 * u);
    g.fillStyle = shirt;
    g.fillRect(x - 0.08 * u, -1.42 * u + l, 0.16 * u, 0.2 * u);
    if (p.gk) {
      g.fillStyle = "#f2f2f2";
      g.beginPath();
      g.arc(x, -0.86 * u + l, 0.1 * u, 0, TAU);
      g.fill();
    }
  };
  if (view === "side") arm(sw * 0.9, 0);
  else {
    arm(-0.36 * u, -Math.sin(phase * 2) * 0.05 * u * moving);
    arm(0.36 * u, Math.sin(phase * 2) * 0.05 * u * moving);
  }
  g.fillStyle = shirt;
  g.beginPath();
  g.roundRect(-0.27 * u, -1.46 * u, 0.54 * u, 0.62 * u, 0.12 * u);
  g.fill();
  if (view === "side") arm(-sw * 0.9, 0);
  const hy = -1.7 * u;
  g.fillStyle = skin;
  g.beginPath();
  g.arc(0, hy, 0.2 * u, 0, TAU);
  g.fill();
  g.fillStyle = hair;
  g.beginPath();
  if (view === "away") g.arc(0, hy, 0.21 * u, 0, TAU);
  else g.arc(0, hy, 0.21 * u, Math.PI, 0);
  g.fill();
  g.fillStyle = COLORS[t];
  g.fillRect(-0.2 * u, hy - 0.05 * u, 0.4 * u, 0.06 * u);
  g.restore();
  g.globalAlpha = 1;
}

function ball2d(b: { x: number; z: number; h: number }, now: number, reach: boolean) {
  const [X, Yg, k] = proj(b.x, 0, b.z);
  const [, Yb] = proj(b.x, BALL_R + b.h, b.z);
  const r = BALL_R * k * 1.15;
  const sh = 1 - Math.min(0.5, b.h * 0.1);
  g.fillStyle = "rgba(0,0,0,.4)";
  g.beginPath();
  g.ellipse(X, Yg, r * sh, r * 0.45 * sh, 0, 0, TAU);
  g.fill();
  if (reach) {
    g.strokeStyle = "#ffe34d";
    g.lineWidth = 2;
    g.beginPath();
    g.ellipse(X, Yg, r * 1.7, r * 0.75, 0, 0, TAU);
    g.stroke();
  }
  g.fillStyle = "#fbfaf5";
  g.strokeStyle = "#262626";
  g.lineWidth = Math.max(1.5, r * 0.16);
  g.beginPath();
  g.arc(X, Yb, r, 0, TAU);
  g.fill();
  g.stroke();
  const a = (b.x + b.z) * 1.4 + now / 4000;
  g.fillStyle = "#262626";
  for (let i = 0; i < 3; i++) {
    const ang = a + (i * TAU) / 3;
    g.beginPath();
    g.arc(X + Math.cos(ang) * r * 0.5, Yb + Math.sin(ang) * r * 0.5, r * 0.22, 0, TAU);
    g.fill();
  }
}

function scene(now: number, dt: number, W: number, H: number) {
  const gm = room.state.game;
  const me = room.mine;
  const b = room.view("ball", 0);

  // Seguimiento del paso de cada jugador (para animar las piernas).
  const ids = [...room.state.people.keys()];
  const seen = new Set<number>();
  for (const id of ids) {
    const p = room.view("people", id);
    if (!p) continue;
    seen.add(id);
    const s = motion.get(id) ?? { x: p.x, z: p.z, speed: 0, phase: 0 };
    const d = Math.hypot(p.x - s.x, p.z - s.z) / Math.max(dt, 0.001);
    s.speed = s.speed * 0.7 + Math.min(d, 14) * 0.3;
    s.phase += s.speed * dt * 1.1;
    s.x = p.x;
    s.z = p.z;
    motion.set(id, s);
  }
  for (const id of [...motion.keys()]) if (!seen.has(id)) motion.delete(id);

  if (useGL) {
    try {
      renderGL(now, W, H);
    } catch {
      disableGL();
    }
  }
  if (useGL) g.clearRect(0, 0, W, H);
  else {
    sky(W, H);
    floor2d();
    boards2d();
    goals2d();
  }

  // Zona de respeto de la reanudación: los rivales no pueden entrar.
  if (gm.phase === Phase.Restart && b) {
    g.setLineDash([10, 8]);
    ring(b.x, b.z, gm.rradius, COLORS[gm.rteam % 2], 3);
    g.setLineDash([]);
  }
  // Dirección y fuerza del tiro mientras se carga.
  if (charging && me) {
    const frac = Math.min(1, (now - chargeStart) / 900);
    const a = aim();
    g.strokeStyle = `rgba(255,${Math.round(227 - 140 * frac)},77,.85)`;
    g.lineWidth = 3;
    g.setLineDash([8, 7]);
    g.beginPath();
    for (let i = 0; i <= 10; i++) {
      const d = 0.8 + (i / 10) * (3 + frac * 6);
      const p = P(me.x + Math.cos(a) * d, 0, me.z + Math.sin(a) * d);
      if (i) g.lineTo(p[0], p[1]);
      else g.moveTo(p[0], p[1]);
    }
    g.stroke();
    g.setLineDash([]);
  }

  // De lejos a cerca, así los de atrás quedan tapados por los de adelante.
  const ents: { z: number; draw: () => void }[] = [];
  for (const id of ids) {
    const p = room.view("people", id);
    if (!p) continue;
    const taking = gm.phase === Phase.Restart && p.has;
    ents.push({
      z: p.z,
      draw: () => {
        if (!useGL) character2d(id, p, now);
        label(p, now, taking);
      },
    });
  }
  if (b && !useGL) {
    const reach = !!(me && Math.hypot(b.x - me.x, b.z - me.z) <= KICK_RANGE && !me.has);
    ents.push({ z: b.z - 0.01, draw: () => ball2d(b, now, reach) });
  }
  ents.sort((a, c) => c.z - a.z);
  for (const e of ents) e.draw();
  if (!useGL) frontBoard2d();

  // Fogonazos de los tiros.
  for (let i = kicks.length - 1; i >= 0; i--) {
    const k = kicks[i];
    const f = (now - k.t) / 300;
    if (f > 1) {
      kicks.splice(i, 1);
      continue;
    }
    const [x, y, s] = proj(k.x, 0, k.z);
    g.strokeStyle = `rgba(255,255,255,${1 - f})`;
    g.lineWidth = 2;
    g.beginPath();
    g.ellipse(x, y, (0.4 + f * 1.6) * s, (0.4 + f * 1.6) * s * 0.45, 0, 0, TAU);
    g.stroke();
  }
  // Carga del tiro: anillo alrededor de los pies.
  if (charging && me) {
    const frac = Math.min(1, (now - chargeStart) / 900);
    const [x, y, s] = proj(me.x, 0, me.z);
    g.strokeStyle = frac >= 1 ? "#ff5a36" : "#ffe34d";
    g.lineWidth = 4;
    g.beginPath();
    g.ellipse(x, y, s * 1.05, s * 0.47, 0, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
    g.stroke();
  }
  // Carteles que suben y se desvanecen (gambetas, barridas, tarjetas, banda...).
  for (let i = popups.length - 1; i >= 0; i--) {
    const pp = popups[i];
    const f = (now - pp.t) / 1300;
    if (f > 1) {
      popups.splice(i, 1);
      continue;
    }
    const [x, y, s] = proj(pp.x, 2.2, pp.z);
    g.globalAlpha = 1 - f * f;
    g.font = `800 ${Math.max(16, s * (0.8 + (1 - f) * 0.25))}px "Sora", sans-serif`;
    g.textAlign = "center";
    g.lineWidth = 5;
    g.strokeStyle = "rgba(0,0,0,.75)";
    g.strokeText(pp.text, x, y - f * s * 1.8);
    g.fillStyle = pp.color;
    g.fillText(pp.text, x, y - f * s * 1.8);
    g.globalAlpha = 1;
  }
}

function frame(now: number) {
  const dt = Math.min((now - (lastFrame || now - 16)) / 1000, 0.05);
  lastFrame = now;
  const dpr = devicePixelRatio || 1;
  const W = innerWidth;
  const H = innerHeight;
  for (const c of [cv, glCv]) {
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  fitCamera(W, H);
  // La cámara acompaña la pelota hacia los costados (suave).
  const b = room.view("ball", 0);
  const target = b ? Math.max(-PAN_MAX, Math.min(PAN_MAX, b.x * 0.75)) : 0;
  CAM_X += (Math.max(-PAN_MAX, Math.min(PAN_MAX, target)) - CAM_X) * Math.min(1, dt * 3);
  CAM_X = Math.max(-PAN_MAX, Math.min(PAN_MAX, CAM_X));
  update(dt);
  g.save();
  if (now < shakeUntil) g.translate((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7);
  scene(now, dt, W, H);
  g.restore();
  hud(now);
  requestAnimationFrame(frame);
}

// ── pantalla ──
let lastHud = 0;
function hud(now: number) {
  if (now - lastHud < 100) return;
  lastHud = now;
  const gm = room.state.game;
  const ph = gm.phase;
  if (ph !== Phase.End && !$("endBox").hidden && now - resultAt > 1500) $("endBox").hidden = true;

  const half = gm.half === 2 ? "2.º tiempo" : "1.er tiempo";
  const phaseName = ["Calentando", "¡Prepárense!", half, half, "¡Gol!", "Entretiempo", "Final"][ph] ?? "";
  $("phase").textContent = phaseName;
  const t = gm.timeLeft;
  const showClock = ph === Phase.Playing || ph === Phase.Restart || ph === Phase.Goal;
  $("time").textContent = showClock ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}` : "";
  $("sRed").textContent = String(gm.red);
  $("sBlue").textContent = String(gm.blue);
  $("countdown").hidden = ph !== Phase.Countdown;
  $("countNum").textContent = String(gm.timeLeft || "");

  $("fRed").textContent = String(gm.foulsRed);
  $("fBlue").textContent = String(gm.foulsBlue);
  $("fRedBox").classList.toggle("hot", gm.foulsRed >= FOULS_LIMIT);
  $("fBlueBox").classList.toggle("hot", gm.foulsBlue >= FOULS_LIMIT);
  const rs = $("restart");
  rs.hidden = ph !== Phase.Restart;
  if (ph === Phase.Restart) {
    const timed = gm.rkind === Rk.KickIn || gm.rkind === Rk.Corner || gm.rkind === Rk.GoalClear || gm.rkind === Rk.Free;
    rs.textContent = `${RK_NAMES[gm.rkind]} · ${TEAM_NAMES[gm.rteam % 2]}${timed ? ` · ${gm.rleft}s` : ""}`;
    rs.style.color = COLORS[gm.rteam % 2];
  }

  const rows = [...room.state.seats.keys()].map((id) => ({ id, s: room.view("seats", id) })).filter((r) => !!r.s);
  for (const team of [0, 1]) {
    $(team === 0 ? "listRed" : "listBlue").innerHTML = rows
      .filter((r) => r.s!.team === team)
      .map((r) => {
        const s = r.s!;
        const extra = `${s.goals ? `⚽ ${s.goals} ` : ""}${s.fouls ? `F${s.fouls} ` : ""}${s.card === 1 ? "🟨" : s.card === 2 ? "🟥" : ""}`;
        return `<li><span class="${r.id === room.selfId ? "me" : ""}">${s.gk ? "🧤 " : ""}${esc(s.name)}</span><span class="n">${extra}</span></li>`;
      })
      .join("");
  }
  $("invite").hidden = ph !== Phase.Lobby;
  $("gk").textContent = room.view("seats", room.selfId)?.gk ? "Dejar el arco" : "Ser arquero";
  $("help").textContent =
    ph === Phase.Lobby
      ? "Calentá con la pelota · WASD mover · Shift correr · clic/Espacio (mantener) tirar · E pase · Q gambeta · C barrida"
      : ph === Phase.Restart
        ? "Reanudación: el que saca tiene 4 segundos · los rivales quedan afuera del círculo"
        : "WASD mover · Shift correr · clic/Espacio (mantener) tirar · E pase · Q gambeta · C barrida (por la espalda es falta)";
  $("net").textContent = `Sala ${room.roomId} · ${room.ping} ms${useGL ? " · 3D" : ""}`;
}
