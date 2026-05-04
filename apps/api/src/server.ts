import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { FastifyReply } from "fastify";
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

app.get("/health", async () => ({
  status: "ok",
  service: "promovid-api"
}));

await app.register(dashboardRoutes, { prefix: "/api" });
await app.register(projectRoutes, { prefix: "/api" });
await app.register(assetRoutes, { prefix: "/api" });
await app.register(providerRoutes, { prefix: "/api" });

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);
const webDistPath = path.resolve(currentDirectory, "../../web/dist");
const webIndexPath = path.join(webDistPath, "index.html");
const webAssetsPath = path.join(webDistPath, "assets");

app.get("/files/:filename", async (request, reply) => sendStaticFile(reply, path.resolve(config.LOCAL_STORAGE_PATH), routeParam(request.params, "filename")));
app.get("/renders/:filename", async (request, reply) => sendStaticFile(reply, path.resolve("./renders"), routeParam(request.params, "filename")));
app.get("/assets/:filename", async (request, reply) => sendStaticFile(reply, webAssetsPath, routeParam(request.params, "filename")));

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

if (config.RUN_INLINE_RENDER_WORKER !== "false") {
  await import("./worker.js");
  app.log.info("Inline render worker started in web service");
}

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

async function sendStaticFile(reply: FastifyReply, root: string, relativePath: string) {
  const safeRelativePath = decodeURIComponent(relativePath).replace(/^[/\\]+/, "");
  const resolvedPath = path.resolve(root, safeRelativePath);
  const relativeToRoot = path.relative(root, resolvedPath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot) || !existsSync(resolvedPath)) {
    reply.code(404).send({ error: "Not found" });
    return;
  }

  reply.type(contentTypeFor(resolvedPath)).send(await readFile(resolvedPath));
}

function routeParam(params: unknown, key: string) {
  return typeof params === "object" && params && key in params ? String((params as Record<string, unknown>)[key]) : "";
}

function contentTypeFor(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "application/javascript",
    ".json": "application/json",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp"
  };
  return contentTypes[extension] ?? "application/octet-stream";
}
