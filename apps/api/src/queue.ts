import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { RenderJobPayload } from "@promovid/shared";
import { config } from "./config.js";

export const redisConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const renderQueue = new Queue<RenderJobPayload>("render-jobs", {
  connection: redisConnection
});
