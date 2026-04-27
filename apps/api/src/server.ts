import path from "node:path";
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
