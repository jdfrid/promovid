import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().default("dev-secret"),
  ENCRYPTION_KEY: z.string().default("0123456789abcdef0123456789abcdef"),
  LOCAL_STORAGE_PATH: z.string().default("./uploads"),
  APP_URL: z.string().default("http://localhost:5173")
});

export const config = schema.parse(process.env);
