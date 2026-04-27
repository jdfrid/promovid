import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { storeLocalFile } from "../storage.js";

const assetTypeSchema = z.enum(["VIDEO", "IMAGE", "VOICE", "MUSIC", "AVATAR", "SCRIPT"]);

export async function assetRoutes(app: FastifyInstance) {
  app.get("/assets", async (request) => {
    const query = z.object({ type: assetTypeSchema.optional() }).parse(request.query);
    const tenant = await getDemoTenant();
    const assets = await prisma.asset.findMany({
      where: { tenantId: tenant.id, type: query.type },
      orderBy: { createdAt: "desc" }
    });
    return { data: assets };
  });

  app.post("/assets", async (request, reply) => {
    const tenant = await getDemoTenant();
    const multipart = await request.file();

    if (!multipart) {
      reply.code(400);
      return { error: "file is required" };
    }

    const fields = multipart.fields as Record<string, { value?: string }>;
    const type = assetTypeSchema.parse(fields.type?.value ?? "IMAGE");
    const tempDirectory = path.join(os.tmpdir(), "promovid");
    await mkdir(tempDirectory, { recursive: true });
    const tempPath = path.join(tempDirectory, multipart.filename);
    await pipeline(multipart.file, await writeFileStream(tempPath));
    const stored = await storeLocalFile(tempPath, multipart.filename);

    const asset = await prisma.asset.create({
      data: {
        tenantId: tenant.id,
        type,
        name: fields.name?.value ?? multipart.filename,
        url: stored.url,
        mimeType: multipart.mimetype,
        tags: fields.tags?.value?.split(",").map((tag) => tag.trim()).filter(Boolean) ?? []
      }
    });

    reply.code(201);
    return { data: asset };
  });
}

async function getDemoTenant() {
  return prisma.tenant.findUniqueOrThrow({
    where: { slug: "demo" }
  });
}

async function writeFileStream(target: string) {
  const { createWriteStream } = await import("node:fs");
  return createWriteStream(target);
}
