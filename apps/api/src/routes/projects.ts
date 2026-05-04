import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { renderQueue } from "../queue.js";
import { analyzeScript, generateScript } from "../providers/scriptProvider.js";
import { collectSceneAssets } from "../providers/assetProvider.js";
import { decryptSecret } from "../crypto.js";
import { processRenderJob } from "../worker.js";
import { buildAndStoreRenderPackage, buildMaterialLibrary } from "../render/renderPackageService.js";

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

  app.get("/projects/:projectId", async (request) => {
    const params = z.object({ projectId: z.string() }).parse(request.params);
    const tenant = await getDemoTenant();
    const project = await prisma.project.findFirstOrThrow({
      where: { id: params.projectId, tenantId: tenant.id },
      include: {
        scenes: { orderBy: { order: "asc" } },
        renderJobs: { orderBy: { createdAt: "desc" } }
      }
    });
    return { data: project };
  });

  app.get("/projects/:projectId/logs", async (request) => {
    const params = z.object({ projectId: z.string() }).parse(request.params);
    const tenant = await getDemoTenant();
    const jobs = await prisma.renderJob.findMany({
      where: { projectId: params.projectId, tenantId: tenant.id },
      select: { id: true }
    });
    const logs = await prisma.auditLog.findMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { entity: "Project", entityId: params.projectId },
          { entity: "RenderJob", entityId: { in: jobs.map((job) => job.id) } }
        ]
      },
      orderBy: { createdAt: "desc" },
      take: 120
    });
    return { data: logs };
  });

  app.get("/render-files/:fileId", async (request, reply) => {
    const params = z.object({ fileId: z.string() }).parse(request.params);
    const tenant = await getDemoTenant();
    const file = await prisma.renderFile.findFirstOrThrow({
      where: {
        id: params.fileId,
        tenantId: tenant.id
      }
    });

    reply
      .header("content-type", file.mimeType)
      .header("content-length", String(file.sizeBytes))
      .header("content-disposition", `attachment; filename="${file.filename}"`)
      .send(Buffer.from(file.data));
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

    const scriptProvidersRaw = await prisma.providerCredential.findMany({
      where: {
        tenantId: tenant.id,
        type: "SCRIPT",
        enabled: true
      },
      orderBy: { priority: "asc" }
    });
    const scriptProviders = dedupeProvidersByName(scriptProvidersRaw);
    logOperation("script_providers_loaded", scriptProviders.length ? "נטענו ספקי תסריט פעילים לפי priority" : "לא נמצא ספק תסריט פעיל, משתמש ב-fallback מקומי", {
      providerCount: scriptProviders.length,
      providers: scriptProviders.map((provider) => ({
        provider: provider.provider,
        priority: provider.priority,
        hasKey: Boolean(provider.encryptedKey)
      }))
    });

    let scriptResult: Awaited<ReturnType<typeof generateScript>>;
    try {
      scriptResult = await generateScriptWithFailover(input, scriptProviders, logOperation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Script generation failed";
      logOperation("script_generation_failed", "יצירת התסריט נכשלה", { error: message });
      await writeAuditLogs(tenant.id, operationLogs);
      reply.code(500);
      return { error: message, operationLogs };
    }
    logOperation("script_generation_complete", "יצירת התסריט הסתיימה", {
      sceneCount: scriptResult.scenes.length,
      backgroundVideoPrompt: scriptResult.backgroundVideoPrompt,
      musicPrompt: scriptResult.musicPrompt
    });

    const project = await prisma.project.create({
      data: {
        tenantId: tenant.id,
        title: input.title,
        sourceText: input.sourceText,
        mode: input.mode,
        targetAudience: input.targetAudience,
        style: input.style,
        backgroundVideoPrompt: scriptResult.backgroundVideoPrompt,
        musicPrompt: scriptResult.musicPrompt,
        duration: input.duration,
        aspectRatio: input.aspectRatio,
        status: "SCRIPT_READY",
        scenes: {
          create: scriptResult.scenes.map((scene, index) => ({
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
    scheduleInlineRenderRescue({
      jobId: renderJob.id,
      tenantId: tenant.id,
      projectId: project.id
    });

    reply.code(202);
    return { data: renderJob };
  });

}

async function generateScriptWithFailover(
  input: z.infer<typeof createProjectSchema>,
  scriptProviders: Awaited<ReturnType<typeof prisma.providerCredential.findMany>>,
  logOperation: (step: string, message: string, metadata?: Record<string, unknown>) => void
) {
  if (scriptProviders.length === 0) {
    return generateScript({ ...input, onLog: logOperation, provider: null });
  }

  const errors: string[] = [];
  for (const provider of scriptProviders) {
    logOperation("script_provider_attempt_start", "מנסה ליצור תסריט עם ספק", {
      provider: provider.provider,
      priority: provider.priority,
      hasKey: Boolean(provider.encryptedKey)
    });

    try {
      const scenes = await generateScript({
        ...input,
        onLog: logOperation,
        provider: {
          provider: provider.provider,
          apiKey: provider.encryptedKey ? decryptSecret(provider.encryptedKey) : undefined,
          config: provider.config
        }
      });
      logOperation("script_provider_attempt_success", "ספק התסריט החזיר תוצאה תקינה", {
        provider: provider.provider,
        sceneCount: scenes.scenes.length,
        backgroundVideoPrompt: scenes.backgroundVideoPrompt,
        musicPrompt: scenes.musicPrompt
      });
      return scenes;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown provider error";
      if (!errors.includes(message)) {
        errors.push(message);
      }
      logOperation("script_provider_attempt_failed", "ספק התסריט נכשל, ממשיך לספק הבא אם קיים", {
        provider: provider.provider,
        error: message
      });
    }
  }

  throw new Error(`All active SCRIPT providers failed. ${errors.join(" | ")}`);
}

function dedupeProvidersByName<T extends { provider: string }>(providers: T[]) {
  const seen = new Set<string>();
  return providers.filter((provider) => {
    const key = provider.provider.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
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

function scheduleInlineRenderRescue(input: { jobId: string; tenantId: string; projectId: string }) {
  setTimeout(() => {
    void rescueQueuedRenderJob(input);
  }, 3000);
}

async function rescueQueuedRenderJob(input: { jobId: string; tenantId: string; projectId: string }) {
  const claimed = await prisma.renderJob.updateMany({
    where: {
      id: input.jobId,
      tenantId: input.tenantId,
      status: "QUEUED"
    },
    data: {
      status: "RUNNING",
      stage: "inline_rescue",
      progress: 1
    }
  });

  if (claimed.count === 0) {
    return;
  }

  await prisma.auditLog.create({
    data: {
      tenantId: input.tenantId,
      action: "inline_render_rescue_started",
      entity: "RenderJob",
      entityId: input.jobId,
      metadata: {
        message: "ה־job נשאר בתור ולכן שירות ה־web מתחיל לעבד אותו ישירות",
        at: new Date().toISOString(),
        projectId: input.projectId
      }
    }
  });

  try {
    await processRenderJob(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Inline render rescue failed";
    await prisma.renderJob.update({
      where: { id: input.jobId },
      data: {
        status: "FAILED",
        error: message,
        progress: 100
      }
    });
    await prisma.project.update({
      where: { id: input.projectId },
      data: { status: "FAILED" }
    });
    await prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: "inline_render_rescue_failed",
        entity: "RenderJob",
        entityId: input.jobId,
        metadata: {
          message,
          at: new Date().toISOString(),
          projectId: input.projectId
        }
      }
    });
  }
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
