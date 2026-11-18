// Cliente de red: reemplaza a @fogon/client. WebSocket al servidor propio, con interpolación de lo que mueven los demás.
export interface RoomClient<_T = any> {
  state: any;
  mine: any;
  selfId: number;
  roomId: string;
  ping: number;
  view(coll: string, id: number): any;
  move(p: { x: number; z: number; yaw: number }): void;
  send(type: string, data?: unknown): void;
  on(type: string, fn: (d: any) => void): void;
}
export function platformUser(): { name: string } | null {
  return null;
}
const lerpAngle = (a: number, b: number, k: number) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

export function join(game: any, opts: { name: string; room: string }): Promise<RoomClient> {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(opts.room)}&name=${encodeURIComponent(opts.name)}`);
    const handlers = new Map<string, ((d: any) => void)[]>();
    const emit = (type: string, d: any) => handlers.get(type)?.forEach((fn) => fn(d));
    const defs: Record<string, any> = game.state;
    const state: any = {};
    for (const [k, d] of Object.entries(defs)) state[k] = (d as any).kind === "collection" ? new Map() : {};
    let prev: any = null;
    let cur: any = null;
    let curT = 0;
    let interval = 50;
    let entity = -1;
    let seq = 0;
    const local = { x: 0, z: 0, yaw: 0 };
    let haveLocal = false;
    let lastSend = 0;
    const room: RoomClient = {
      state,
      get mine() {
        return state.people?.get(entity);
      },
      selfId: 0,
      roomId: opts.room,
      ping: 0,
      view(coll, id) {
        const d = defs[coll];
        if (!d || d.kind !== "collection") return state[coll];
        const c = state[coll].get(id);
        if (!c || (coll === "people" && id === entity)) return c;
        const lerp: string[] = d.opts?.lerp ?? [];
        const ang: string[] = d.opts?.angle ?? [];
        const pv = prev?.[coll]?.get(id);
        if (!pv || (!lerp.length && !ang.length)) return c;
        const k = Math.max(0, Math.min(1, (performance.now() - curT) / interval));
        const o = { ...c };
        for (const f of lerp) o[f] = pv[f] + (c[f] - pv[f]) * k;
        for (const f of ang) o[f] = lerpAngle(pv[f], c[f], k);
        return o;
      },
      move(p) {
        local.x = p.x;
        local.z = p.z;
        local.yaw = p.yaw;
        const m = state.people?.get(entity);
        if (m) Object.assign(m, local);
        const now = performance.now();
        if (now - lastSend >= 33 && ws.readyState === 1) {
          lastSend = now;
          ws.send(JSON.stringify({ t: "move", seq, ...local }));
        }
      },
      send(type, data) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: "m", type, data }));
      },
      on(type, fn) {
        const l = handlers.get(type) ?? [];
        l.push(fn);
        handlers.set(type, l);
      },
    };
    const toMap = (arr: [number, any][]) => new Map(arr);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === "welcome") {
        room.selfId = msg.playerId;
        entity = msg.entity;
        resolve(room);
      } else if (msg.t === "s") {
        const now = performance.now();
        if (cur) interval = Math.max(20, Math.min(150, now - curT));
        prev = cur;
        const next: any = {};
        for (const [k, d] of Object.entries(defs)) {
          if ((d as any).kind === "collection") next[k] = toMap(msg[k]);
          else next[k] = msg[k];
        }
        cur = next;
        curT = now;
        for (const k of Object.keys(defs)) state[k] = (defs[k] as any).kind === "collection" ? new Map([...next[k]].map(([i, v]: any) => [i, { ...v }])) : { ...next[k] };
        const m = state.people.get(entity);
        if (m && haveLocal) Object.assign(m, local);
      } else if (msg.t === "own") {
        seq = msg.seq;
        Object.assign(local, { x: msg.x, z: msg.z, yaw: msg.yaw });
        haveLocal = true;
        const m = state.people.get(entity);
        if (m) Object.assign(m, local);
      } else if (msg.t === "pong") {
        room.ping = Math.round(performance.now() - msg.ts);
      } else if (msg.t === "ev") {
        emit(msg.type, msg.data);
      }
    };
    ws.onclose = () => {
      emit("close", {});
      reject(new Error("closed"));
    };
    ws.onerror = () => reject(new Error("ws error"));
    setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "ping", ts: performance.now() })), 2000);
  });
}
