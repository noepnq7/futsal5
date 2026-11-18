// Futsal 5: medidas y reglas que comparten el servidor y la página.
import { collection, defineGame, schema, single, t } from "./net/net";

/**
 * Jugadores y bots, todos iguales en el estado. yaw = dirección en que miran, en el plano (x, z).
 * fx: efecto (gambeta, aturdido, expulsado). has: tiene la pelota o va a sacar. gk: es el arquero. card: 0 nada, 1 amarilla, 2 roja.
 */
export const Person = schema({ x: t.q16(0.01), z: t.q16(0.01), yaw: t.angle8, team: t.u8, bot: t.bool, name: t.str, fx: t.u8, has: t.bool, gk: t.bool, card: t.u8 });
/** h = altura de la pelota (solo para dibujarla). */
export const Ball = schema({ x: t.q16(0.01), z: t.q16(0.01), h: t.q16(0.01) });
export const Seat = schema({ name: t.str, team: t.u8, goals: t.u8, fouls: t.u8, card: t.u8, gk: t.bool });
export const Game = schema({
  phase: t.u8,
  timeLeft: t.u16,
  /** 0 antes de empezar, 1 primer tiempo, 2 segundo tiempo. */
  half: t.u8,
  red: t.u8,
  blue: t.u8,
  /** Faltas acumuladas de cada equipo en el tiempo actual. */
  foulsRed: t.u8,
  foulsBlue: t.u8,
  /** Reanudación pendiente: tipo (Rk), equipo que saca, segundos que le quedan y radio de respeto. */
  rkind: t.u8,
  rteam: t.u8,
  rleft: t.u8,
  rradius: t.u8,
});

export const game = defineGame({
  state: {
    people: collection(Person, { lerp: ["x", "z"], angle: ["yaw"] }),
    /** La pelota es la entidad 0. */
    ball: collection(Ball, { lerp: ["x", "z", "h"] }),
    /** Quién está en la sala (por id de jugador). */
    seats: collection(Seat),
    game: single(Game),
  },
  owned: {
    people: { fields: ["x", "z", "yaw"], maxSpeed: 14 },
  },
});

export const Phase = { Lobby: 0, Countdown: 1, Playing: 2, Restart: 3, Goal: 4, Halftime: 5, End: 6 } as const;
export const Team = { Red: 0, Blue: 1 } as const;
export const Fx = { None: 0, Trick: 1, Stun: 2, Out: 3 } as const;
/** Tipos de reanudación. */
export const Rk = { None: 0, Kickoff: 1, KickIn: 2, Corner: 3, GoalClear: 4, Free: 5, Penalty: 6, Penalty10: 7 } as const;

/** Cancha reglamentaria de futsal, en metros: 40 x 20, arcos de 3 x 2. */
export const HALF_L = 20;
export const HALF_W = 10;
export const GOAL_HALF = 1.5;
export const GOAL_DEPTH = 1.2;
export const GOAL_H = 2;
export const BALL_R = 0.3;
export const PLAYER_R = 0.45;
/** Área penal: cuarto de círculo de 6 m desde cada palo. Punto penal a 6 m, segundo punto a 10 m. */
export const AREA_R = 6;
export const SPOT = 6;
export const SPOT2 = 10;
export const CIRCLE_R = 3;

export const SPEED = 6.2;
export const SPRINT = 8.2;
export const DASH_SPEED = 11;
export const BOT_SPEED = 5.2;

export const PICKUP_R = 0.9;
export const GK_PICKUP_R = 1.35;
/** El arquero ataja con las manos las pelotas que vienen más lentas que esto (los tiros muy fuertes lo vencen). */
export const GK_CATCH_SPEED = 17;
export const KICK_RANGE = 1.5;
export const TACKLE_RANGE = 1.5;
export const SHOT_MIN = 11;
export const SHOT_MAX = 23;
export const PASS_SPEED = 14;

export const TRICK_MS = 650;
export const TRICK_CD = 1300;
export const TACKLE_CD = 900;
export const TRICK_NAMES = ["¡Gambeta!", "¡Caño!", "¡Rabona!", "¡Sombrerito!", "¡Taco!", "¡Elástica!"];

export const MAX_TEAM = 5;
/** 5 por equipo: arquero y cuatro jugadores. Si faltan, juegan bots. */
export const MIN_TEAM = 5;
export const COUNTDOWN_SECONDS = 3;
/** Dos tiempos de 3 minutos de juego efectivo (el reloj corre solo con la pelota en juego). */
export const HALF_SECONDS = 180;
export const HALFTIME_SECONDS = 8;
export const GOAL_SECONDS = 3;
export const END_SECONDS = 12;
/** Regla de los 4 segundos para sacar (banda, esquina, saque de arco, tiro libre) y para que el arquero suelte la pelota. */
export const RULE_SECONDS = 4;
export const LONG_RESTART_SECONDS = 10;
export const GK_HOLD_MS = 4000;
/** A la sexta falta acumulada de un equipo, cada falta se paga con tiro de 10 metros sin barrera. */
export const FOULS_LIMIT = 5;
export const OUT_SECONDS = 120;

/** Hacia dónde ataca un equipo: Rojo hacia +x en el primer tiempo; en el segundo se cambian de lado. */
export function attackDir(team: number, half: number): number {
  return team === Team.Red === (half !== 2) ? 1 : -1;
}

/** Distancia de un punto al arco que está en x = side * HALF_L (medida desde el segmento entre los palos). */
export function areaDist(x: number, z: number, side: number): number {
  const dx = Math.max(0, HALF_L - side * x);
  const dz = Math.max(0, Math.abs(z) - GOAL_HALF);
  return Math.hypot(dx, dz);
}
/** ¿Está adentro del área penal del arco que queda del lado `side`? */
export function inPenaltyArea(x: number, z: number, side: number): boolean {
  return side * x > 0 && areaDist(x, z, side) <= AREA_R;
}

/** Posiciones de saque (para el que ataca hacia +x; el otro es el espejo). El primero es el arquero. */
export const FORMATION = [
  { x: -18.2, z: 0 },
  { x: -11, z: 5 },
  { x: -11, z: -5 },
  { x: -6.5, z: 3 },
  { x: -6.5, z: -3 },
];
export function slotSpot(team: number, slot: number, half: number) {
  const f = FORMATION[slot % FORMATION.length];
  const d = attackDir(team, half);
  return { x: f.x * d, z: f.z * d };
}
