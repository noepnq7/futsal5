import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import room from "./room";
import { RoomImpl, type Player } from "../net/server";

const PORT = Number(process.env.PORT) || 5300;
const PUB = path.resolve(process.argv[1] ? path.dirname(process.argv[1]) : ".", "../public");
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const rel = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
  const f = path.join(PUB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404).end("no encontrado");
    return;
  }
  res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(fs.readFileSync(f));
});

const rooms = new Map<string, RoomImpl>();
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const u = new URL(req.url ?? "", "http://x");
  const id = (u.searchParams.get("room") || "main").slice(0, 24).replace(/[^\w-]/g, "");
  let r = rooms.get(id);
  if (!r) {
    r = new RoomImpl(room as any, id);
    rooms.set(id, r);
  }
  const p: Player | null = r.join(ws, u.searchParams.get("name") ?? "");
  if (!p) return ws.close();
  ws.on("message", (raw) => {
    try {
      r!.handle(p, JSON.parse(raw.toString()));
    } catch {}
  });
  ws.on("close", () => r!.leave(p));
});
setInterval(() => {
  for (const [id, r] of rooms) if (!r.room.players.size && Date.now() - r.emptySince > 60000) {
    r.close();
    rooms.delete(id);
  }
}, 30000);
server.listen(PORT, () => console.log(`Futsal 5 en http://localhost:${PORT}`));
