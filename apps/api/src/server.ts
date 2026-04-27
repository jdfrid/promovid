import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { projectRoutes } from "./routes/projects.js";
import { assetRoutes } from "./routes/assets.js";
import { providerRoutes } from "./routes/providers.js";

const app = fastify({
  logger: true
});

await app.register(cors, {
  origin: true
});

await app.register(multipart, {
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});

await app.register(fastifyStatic, {
  root: path.resolve(config.LOCAL_STORAGE_PATH),
  prefix: "/files/",
  decorateReply: false
});

await app.register(fastifyStatic, {
  root: path.resolve("./renders"),
  prefix: "/renders/",
  decorateReply: false
});

app.get("/health", async () => ({
  status: "ok",
  service: "promovid-api"
}));

await app.register(dashboardRoutes, { prefix: "/api" });
await app.register(projectRoutes, { prefix: "/api" });
await app.register(assetRoutes, { prefix: "/api" });
await app.register(providerRoutes, { prefix: "/api" });

const webDistPath = path.resolve("./apps/web/dist");
const webIndexPath = path.join(webDistPath, "index.html");
const webAssetsPath = path.join(webDistPath, "assets");

if (existsSync(webAssetsPath)) {
  await app.register(fastifyStatic, {
    root: webAssetsPath,
    prefix: "/assets/",
    decorateReply: false
  });
}

app.get("/", async (_request, reply) => {
  reply.type("text/html").send(await readWebAppHtml());
});

app.get("/*", async (request, reply) => {
  const reservedPrefixes = ["/api", "/files", "/renders", "/assets"];
  if (reservedPrefixes.some((prefix) => request.url.startsWith(prefix))) {
    reply.code(404).send({ error: "Not found" });
    return;
  }

  reply.type("text/html").send(await readWebAppHtml());
});

app.setErrorHandler((error: Error, _request, reply) => {
  app.log.error(error);
  reply.status(500).send({
    error: error.message
  });
});

await app.listen({
  port: config.PORT,
  host: "0.0.0.0"
});

async function readWebAppHtml() {
  if (existsSync(webIndexPath)) {
    return readFile(webIndexPath, "utf8");
  }

  return `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AdBot</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f111a; color: #fff; font-family: Arial, sans-serif; }
      main { max-width: 720px; padding: 32px; text-align: center; }
      code { color: #9ea6ff; }
    </style>
  </head>
  <body>
    <main>
      <h1>AdBot API is running</h1>
      <p>השרת פעיל, אך קבצי הממשק לא נמצאו בתוך ה-container.</p>
      <p>בדיקת בריאות: <code>/health</code></p>
    </main>
  </body>
</html>`;
}
