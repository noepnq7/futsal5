# Futsal 5 (sin Fogón)
Futsal 5v5 en 3D, multijugador. Servidor Node + WebSocket (autoritativo) y cliente WebGL propio.

    npm install
    npm start        # http://localhost:5300  (PORT=8080 para otro puerto)

Cada sala se arma con `?room=nombre`; compartí ese link. Si faltan jugadores, juegan bots.
Para jugar con amigos por internet hay que exponer el puerto (tunel tipo cloudflared/ngrok) o desplegar en un hosting con Node.

## Poner online
- **Render (gratis):** subí esta carpeta a un repo de GitHub → render.com → New → Blueprint (usa `render.yaml`). Te da un link `https://futsal-5.onrender.com`.
- **Railway / Fly.io / cualquier hosting con Docker:** usan el `Dockerfile` (puerto desde `PORT`).
Necesita WebSockets (todos los de arriba los soportan).
