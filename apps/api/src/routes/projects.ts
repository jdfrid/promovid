import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { renderQueue } from "../queue.js";
import { generateScript } from "../providers/scriptProvider.js";
import { decryptSecret } from "../crypto.js";

const tenantSlug = "demo";

interface OperationLog {
  at: string;
  step: string;
  message: string;
  metadata?: Record<string, unknown>;
}

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
    const operationLogs: OperationLog[] = [];
    const input = createProjectSchema.parse(request.body);
    const tenant = await getDemoTenant();
    const logOperation = (step: string, message: string, metadata?: Record<string, unknown>) => {
      const entry = {
        at: new Date().toISOString(),
        step,
        message,
        metadata
      };
      operationLogs.push(entry);
      request.log.info({ step, metadata }, message);
    };

    logOperation("project_create_received", "התקבלה בקשה ליצירת תסריט", {
      title: input.title,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      sourceLength: input.sourceText.length
    });

    const scriptProvider = await prisma.providerCredential.findFirst({
      where: {
        tenantId: tenant.id,
        type: "SCRIPT",
        enabled: true
      },
      orderBy: { priority: "asc" }
    });
    logOperation("script_provider_selected", scriptProvider ? "נבחר ספק תסריט פעיל" : "לא נמצא ספק תסריט פעיל, משתמש ב-fallback מקומי", {
      provider: scriptProvider?.provider,
      priority: scriptProvider?.priority,
      hasKey: Boolean(scriptProvider?.encryptedKey)
    });

    let scenes: Awaited<ReturnType<typeof generateScript>>;
    try {
      scenes = await generateScript({
        ...input,
        onLog: logOperation,
        provider: scriptProvider
          ? {
              provider: scriptProvider.provider,
              apiKey: scriptProvider.encryptedKey ? decryptSecret(scriptProvider.encryptedKey) : undefined,
              config: scriptProvider.config
            }
          : null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Script generation failed";
      logOperation("script_generation_failed", "יצירת התסריט נכשלה", { error: message });
      await writeAuditLogs(tenant.id, operationLogs);
      reply.code(500);
      return { error: message, operationLogs };
    }
    logOperation("script_generation_complete", "יצירת התסריט הסתיימה", { sceneCount: scenes.length });

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
    logOperation("project_created", "הפרויקט והסצנות נשמרו במסד הנתונים", { projectId: project.id });
    await writeAuditLogs(tenant.id, operationLogs, project.id);

    reply.code(201);
    return { data: { ...project, operationLogs } };
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

async function writeAuditLogs(tenantId: string, logs: OperationLog[], projectId?: string) {
  if (logs.length === 0) {
    return;
  }

  await prisma.auditLog.createMany({
    data: logs.map((log) => ({
      tenantId,
      action: log.step,
      entity: "Project",
      entityId: projectId,
      metadata: {
        message: log.message,
        at: log.at,
        ...(log.metadata ?? {})
      }
    }))
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
