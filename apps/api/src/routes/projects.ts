import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { renderQueue } from "../queue.js";
import { generateScript } from "../providers/scriptProvider.js";
import { decryptSecret } from "../crypto.js";

const tenantSlug = "demo";

const createProjectSchema = z.object({
  title: z.string().min(2),
  sourceText: z.string().min(2),
  mode: z.enum(["manual", "automatic", "assisted", "series"]).default("manual"),
  targetAudience: z.string().optional(),
  style: z.string().optional(),
  duration: z.number().int().min(15).max(60).default(30),
  aspectRatio: z.enum(["9:16", "16:9", "1:1"]).default("9:16")
});

export async function projectRoutes(app: FastifyInstance) {
  app.get("/projects", async () => {
    const tenant = await getDemoTenant();
    const projects = await prisma.project.findMany({
      where: { tenantId: tenant.id },
      include: { scenes: true, renderJobs: true },
      orderBy: { updatedAt: "desc" }
    });
    return { data: projects };
  });

  app.post("/projects", async (request, reply) => {
    const input = createProjectSchema.parse(request.body);
    const tenant = await getDemoTenant();
    const scriptProvider = await prisma.providerCredential.findFirst({
      where: {
        tenantId: tenant.id,
        type: "SCRIPT",
        enabled: true
      },
      orderBy: { priority: "asc" }
    });
    const scenes = await generateScript({
      ...input,
      provider: scriptProvider
        ? {
            provider: scriptProvider.provider,
            apiKey: scriptProvider.encryptedKey ? decryptSecret(scriptProvider.encryptedKey) : undefined,
            config: scriptProvider.config
          }
        : null
    });

    const project = await prisma.project.create({
      data: {
        tenantId: tenant.id,
        title: input.title,
        sourceText: input.sourceText,
        mode: input.mode,
        targetAudience: input.targetAudience,
        style: input.style,
        duration: input.duration,
        aspectRatio: input.aspectRatio,
        status: "SCRIPT_READY",
        scenes: {
          create: scenes.map((scene, index) => ({
            ...scene,
            order: index
          }))
        }
      },
      include: { scenes: true }
    });

    reply.code(201);
    return { data: project };
  });

  app.post("/projects/:projectId/render", async (request, reply) => {
    const params = z.object({ projectId: z.string() }).parse(request.params);
    const tenant = await getDemoTenant();
    const project = await prisma.project.findFirstOrThrow({
      where: { id: params.projectId, tenantId: tenant.id }
    });

    const renderJob = await prisma.renderJob.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        status: "QUEUED",
        stage: "render"
      }
    });

    await prisma.project.update({
      where: { id: project.id },
      data: { status: "RENDERING" }
    });

    await renderQueue.add("render", {
      jobId: renderJob.id,
      tenantId: tenant.id,
      projectId: project.id
    });

    reply.code(202);
    return { data: renderJob };
  });
}

async function getDemoTenant() {
  return prisma.tenant.upsert({
    where: { slug: tenantSlug },
    update: {},
    create: {
      slug: tenantSlug,
      name: "Demo Studio",
      brandColor: "#6d5dfc"
    }
  });
}
