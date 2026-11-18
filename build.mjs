import { build } from "esbuild";
await build({ entryPoints: ["src/client/main.ts"], bundle: true, outfile: "public/app.js", format: "esm", target: "es2022", sourcemap: true });
await build({ entryPoints: ["src/server/main.ts"], bundle: true, outfile: "dist/server.js", platform: "node", format: "cjs", target: "node22", external: ["ws"] });
console.log("build ok");
