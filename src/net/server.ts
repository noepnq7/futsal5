// Runtime de salas: reemplaza a @fogon/server. Una sala = un partido; el servidor manda y los clientes mueven solo a su jugador.
import type { GameDef, StateOf, Def } from "./net";

export interface Player {
  id: number;
  name: string;
  data: Record<string, any>;
  seq: number;
  ws: any;
  owned: { coll: string; id: number } | null;
  lastMove: number;
}
export interface Room<D extends Record<string, Def<any>> = any> {
  state: StateOf<D>;
  players: Map<number, Player>;
  own(p: Player, coll: string, id: number): void;
  randomId(coll: string): number;
  random(): number;
  broadcast(type: string, data: unknown, except?: Player): void;
  send(p: Player, type: string, data: unknown): void;
}
export interface RoomDef<D extends Record<string, Def<any>> = any> extends GameDef<D> {
  maxPlayers: number;
  tick: number;
  onCreate?(room: Room<D>): void;
  onJoin?(room: Room<D>, p: Player): void;
  onLeave?(room: Room<D>, p: Player): void;
  onTick?(room: Room<D>, dt: number): void;
  messages: Record<string, (room: Room<D>, p: Player, data: any) => void>;
}
export const defineRoom = <D extends Record<string, Def<any>>>(d: RoomDef<D>) => d;

const zero = (kind: string) => (kind === "bool" ? false : kind === "str" ? "" : 0);
const round = (_k: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);

export class RoomImpl {
  room: Room;
  def: RoomDef;
  timer: ReturnType<typeof setInterval>;
  idc = 0;
  playerIdc = 0;
  emptySince = Date.now();
  constructor(def: RoomDef, public id: string) {
    this.def = def;
    const state: any = {};
    for (const [k, d] of Object.entries(def.state as Record<string, Def<any>>)) {
      if (d.kind === "collection") state[k] = new Map();
      else state[k] = Object.fromEntries(Object.entries(d.schema).map(([n, fld]: any) => [n, zero(fld.kind)]));
    }
    const self = this;
    this.room = {
      state,
      players: new Map(),
      own(p, coll, id) {
        p.seq++;
        p.owned = { coll, id };
        const e = state[coll].get(id);
        if (e) self.sendTo(p, { t: "own", seq: p.seq, x: e.x, z: e.z, yaw: e.yaw });
      },
      randomId: () => ++self.idc,
      random: Math.random,
      broadcast(type, data, except) {
        const msg = JSON.stringify({ t: "ev", type, data });
        for (const p of self.room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(msg);
      },
      send(p, type, data) {
        self.sendTo(p, { t: "ev", type, data });
      },
    };
    def.onCreate?.(this.room);
    const dt = 1 / def.tick;
    this.timer = setInterval(() => {
      try {
        def.onTick?.(this.room, dt);
      } catch (e) {
        console.error("tick error", e);
      }
      this.snapshot();
    }, 1000 / def.tick);
  }
  sendTo(p: Player, msg: unknown) {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }
  snapshot() {
    if (!this.room.players.size) return;
    const s = this.room.state as any;
    const out: any = { t: "s" };
    for (const [k, d] of Object.entries(this.def.state as Record<string, Def<any>>)) out[k] = d.kind === "collection" ? [...(s[k] as Map<number, any>)] : s[k];
    const msg = JSON.stringify(out, round);
    for (const p of this.room.players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
  }
  join(ws: any, name: string): Player | null {
    if (this.room.players.size >= this.def.maxPlayers) {
      ws.send(JSON.stringify({ t: "ev", type: "__full", data: {} }));
      return null;
    }
    const p: Player = { id: ++this.playerIdc, name: name.slice(0, 16) || "Jugador", data: {}, seq: 0, ws, owned: null, lastMove: Date.now() };
    this.room.players.set(p.id, p);
    this.def.onJoin?.(this.room, p);
    this.sendTo(p, { t: "welcome", playerId: p.id, entity: p.owned?.id ?? -1, roomId: this.id });
    return p;
  }
  leave(p: Player) {
    this.def.onLeave?.(this.room, p);
    this.room.players.delete(p.id);
    if (!this.room.players.size) this.emptySince = Date.now();
  }
  handle(p: Player, msg: any) {
    if (msg.t === "ping") return this.sendTo(p, { t: "pong", ts: msg.ts });
    if (msg.t === "move") {
      if (!p.owned || msg.seq !== p.seq) return;
      const e = (this.room.state as any)[p.owned.coll].get(p.owned.id);
      const own = (this.def.owned as any)[p.owned.coll];
      if (!e || !own || ![msg.x, msg.z, msg.yaw].every(Number.isFinite)) return;
      const now = Date.now();
      const dt = Math.min(0.5, Math.max(0.03, (now - p.lastMove) / 1000));
      p.lastMove = now;
      const max = own.maxSpeed * dt + 0.5;
      const dx = msg.x - e.x;
      const dz = msg.z - e.z;
      const d = Math.hypot(dx, dz);
      const k = d > max ? max / d : 1;
      e.x += dx * k;
      e.z += dz * k;
      e.yaw = msg.yaw;
      return;
    }
    if (msg.t === "m") {
      const h = this.def.messages[msg.type];
      if (!h) return;
      try {
        h(this.room, p, msg.data);
      } catch (e) {
        console.error("msg error", msg.type, e);
      }
    }
  }
  close() {
    clearInterval(this.timer);
  }
}
