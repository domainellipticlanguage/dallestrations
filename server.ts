import { serve } from "@hono/node-server";
import { app } from "./src/app.js";

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port });
console.log(`API listening on http://localhost:${port}`);
