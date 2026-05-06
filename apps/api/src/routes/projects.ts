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

const supplementalFileSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().optional(),
  assetType: z.string().optional(),
  assetUrl: z.string().optional(),
  extractedText: z.string().max(12000).optional(),
  imageDataUrl: z.string().max(6_000_000).optional()
});

const createProjectSchema = z.object({
  title: z.string().min(2),
  sourceText: z.string().default(""),
  supplementalLinks: z.array(z.string().url()).max(10).default([]),
  supplementalFiles: z.array(supplementalFileSchema).max(8).default([]),
  mode: z.enum(["manual", "automatic", "assisted", "series"]).default("manual"),
  targetAudience: z.string().optional(),
  style: z.string().optional(),
  duration: z.number().int().min(15).max(60).default(30),
  aspectRatio: z.enum(["9:16", "16:9", "1:1"]).default("9:16")
}).refine((data) => data.sourceText.trim() || data.supplementalLinks.length || data.supplementalFiles.length, {
  message: "sourceText, supplementalLinks or supplementalFiles is required",
  path: ["sourceText"]
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

    const enrichedSourceText = buildEnrichedSourceText(input);
    logOperation("project_create_received", "התקבלה בקשה ליצירת תסריט", {
      title: input.title,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      sourceLength: enrichedSourceText.length,
      supplementalLinkCount: input.supplementalLinks.length,
      supplementalFileCount: input.supplementalFiles.length
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
      scriptResult = await generateScriptWithFailover({
        ...input,
        sourceText: enrichedSourceText
      }, scriptProviders, logOperation);
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
        sourceText: enrichedSourceText,
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

  app.post("/projects/:projectId/analyze-script", async (request, reply) => {
    const params = z.object({ projectId: z.string() }).parse(request.params);
    const tenant = await getDemoTenant();
    const operationLogs: OperationLog[] = [];
    const logOperation = createOperationLogger(request.log, operationLogs);
    const project = await prisma.project.findFirstOrThrow({
      where: { id: params.projectId, tenantId: tenant.id },
      include: { scenes: { orderBy: { order: "asc" } } }
    });

    await prisma.project.update({
      where: { id: project.id },
      data: { status: "SCRIPT_ANALYZING" }
    });
    logOperation("script_analysis_started", "מתחיל ניתוח חכם של התסריט, הדיאלוג, הוויזואל והמוסיקה", { projectId: project.id });

    try {
      const scriptProviders = dedupeProvidersByName(await prisma.providerCredential.findMany({
        where: { tenantId: tenant.id, type: "SCRIPT", enabled: true },
        orderBy: { priority: "asc" }
      }));
      const analysis = await analyzeScriptWithFailover({
        title: project.title,
        sourceText: project.sourceText,
        supplementalLinks: [],
        supplementalFiles: [],
        mode: project.mode as z.infer<typeof createProjectSchema>["mode"],
        duration: project.duration,
        style: project.style ?? undefined,
        targetAudience: project.targetAudience ?? undefined,
        aspectRatio: project.aspectRatio as z.infer<typeof createProjectSchema>["aspectRatio"],
        scenes: project.scenes.map((scene) => ({
          title: scene.title,
          narration: scene.narration,
          visualPrompt: scene.visualPrompt,
          durationSeconds: scene.durationSeconds
        }))
      }, scriptProviders, logOperation);

      const updated = await prisma.project.update({
        where: { id: project.id },
        data: {
          status: "SCRIPT_ANALYSIS_READY",
          scriptAnalysis: analysis as unknown as Prisma.InputJsonValue,
          backgroundVideoPrompt: analysis.backgroundVideoPrompt || project.backgroundVideoPrompt,
          musicPrompt: analysis.musicPrompt || project.musicPrompt
        },
        include: { scenes: { orderBy: { order: "asc" } }, renderJobs: { orderBy: { createdAt: "desc" } } }
      });
      logOperation("script_analysis_completed", "ניתוח התסריט הסתיים ונשמר", {
        projectId: project.id,
        sceneCount: analysis.scenes.length,
        characterCount: analysis.characters.length
      });
      await writeAuditLogs(tenant.id, operationLogs, project.id);
      return { data: { ...updated, operationLogs } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Script analysis failed";
      logOperation("script_analysis_failed", "ניתוח התסריט נכשל", { error: message });
      await writeAuditLogs(tenant.id, operationLogs, project.id);
      await prisma.project.update({ where: { id: project.id }, data: { status: "SCRIPT_READY" } });
      reply.code(500);
      return { error: message, operationLogs };
    }
  });

  app.post("/projects/:projectId/collect-assets", async (request) => {
    const params = z.object({ projectId: z.string() }).parse(request.params);
    const tenant = await getDemoTenant();
    const operationLogs: OperationLog[] = [];
    const logOperation = createOperationLogger(request.log, operationLogs);
    const project = await prisma.project.findFirstOrThrow({
      where: { id: params.projectId, tenantId: tenant.id },
      include: { scenes: { orderBy: { order: "asc" } } }
    });

    await prisma.project.update({ where: { id: project.id }, data: { status: "ASSETS_COLLECTING" } });
    logOperation("asset_collection_started", "מתחיל איסוף חומרים לפי ניתוח התסריט", { projectId: project.id, sceneCount: project.scenes.length });

    const providers = await prisma.providerCredential.findMany({
      where: { tenantId: tenant.id, type: { in: ["MEDIA", "VOICE", "MUSIC"] }, enabled: true },
      orderBy: [{ type: "asc" }, { priority: "asc" }]
    });
    const providersByType = {
      MEDIA: providers.filter((provider) => provider.type === "MEDIA"),
      VOICE: providers.filter((provider) => provider.type === "VOICE"),
      MUSIC: providers.filter((provider) => provider.type === "MUSIC")
    };

    for (const scene of project.scenes) {
      logOperation("scene_asset_collection_started", "מתחיל איסוף חומרים לסצנה", { sceneId: scene.id, sceneOrder: scene.order + 1 });
      const analysisScene = findAnalysisScene(project.scriptAnalysis, scene.order);
      const assets = await collectSceneAssets(scene, providersByType, {
        backgroundVideoPrompt: project.backgroundVideoPrompt,
        sceneMediaPrompt: stringFromRecord(analysisScene, "backgroundPrompt") ?? stringFromRecord(analysisScene, "visualRequirements"),
        musicPrompt: stringFromRecord(analysisScene, "musicPrompt") ?? project.musicPrompt
      });
      for (const assetLog of assets.log) {
        logOperation(assetLog.step, assetLog.message, assetLog.metadata);
      }
      await prisma.scene.update({
        where: { id: scene.id },
        data: {
          mediaUrl: assets.mediaUrl,
          referenceMediaUrl: assets.mediaUrl,
          voiceUrl: assets.voiceUrl,
          musicUrl: assets.musicUrl,
          renderLog: { assetCollection: assets.log } as Prisma.InputJsonValue
        }
      });
      logOperation("scene_asset_collection_completed", "איסוף החומרים לסצנה הסתיים", {
        sceneId: scene.id,
        hasMedia: Boolean(assets.mediaUrl),
        hasVoice: Boolean(assets.voiceUrl),
        hasMusic: Boolean(assets.musicUrl)
      });
    }

    const refreshed = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      include: { scenes: { orderBy: { order: "asc" } }, renderJobs: { orderBy: { createdAt: "desc" } } }
    });
    const materialLibrary = buildMaterialLibrary(refreshed, refreshed.scriptAnalysis);
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        status: "ASSETS_READY",
        materialLibrary: materialLibrary as Prisma.InputJsonValue
      },
      include: { scenes: { orderBy: { order: "asc" } }, renderJobs: { orderBy: { createdAt: "desc" } } }
    });
    logOperation("asset_collection_completed", "ספריית החומרים נבנתה ונשמרה", { projectId: project.id });
    await writeAuditLogs(tenant.id, operationLogs, project.id);
    return { data: { ...updated, operationLogs } };
  });

  app.post("/projects/:projectId/render-package", async (request) => {
    const params = z.object({ projectId: z.string() }).parse(request.params);
    const tenant = await getDemoTenant();
    const operationLogs: OperationLog[] = [];
    const logOperation = createOperationLogger(request.log, operationLogs);
    const project = await prisma.project.findFirstOrThrow({
      where: { id: params.projectId, tenantId: tenant.id },
      include: { scenes: { orderBy: { order: "asc" } } }
    });

    await prisma.project.update({ where: { id: project.id }, data: { status: "RENDER_PACKAGE_BUILDING" } });
    logOperation("render_package_started", "מתחיל בניית חבילת רינדור עם manifest, instructions ו-timeline", { projectId: project.id });
    const renderPackage = await buildAndStoreRenderPackage({ tenantId: tenant.id, project });
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        status: "RENDER_PACKAGE_READY",
        renderPackage: renderPackage as unknown as Prisma.InputJsonValue
      },
      include: { scenes: { orderBy: { order: "asc" } }, renderJobs: { orderBy: { createdAt: "desc" } } }
    });
    logOperation("render_package_completed", "חבילת הרינדור מוכנה לאישור", {
      projectId: project.id,
      missingAssetGroups: renderPackage.missingAssets.length,
      files: renderPackage.files
    });
    await writeAuditLogs(tenant.id, operationLogs, project.id);
    return { data: { ...updated, operationLogs } };
  });

  app.post("/projects/:projectId/approve-render-package", async (request) => {
    const params = z.object({ projectId: z.string() }).parse(request.params);
    const tenant = await getDemoTenant();
    const project = await prisma.project.findFirstOrThrow({
      where: { id: params.projectId, tenantId: tenant.id }
    });
    if (!project.renderPackage) {
      throw new Error("יש לבנות חבילת חומרים לפני אישור רינדור");
    }

    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        status: "RENDER_PACKAGE_APPROVED",
        renderPackageApprovedAt: new Date()
      },
      include: { scenes: { orderBy: { order: "asc" } }, renderJobs: { orderBy: { createdAt: "desc" } } }
    });
    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        action: "render_package_approved",
        entity: "Project",
        entityId: project.id,
        metadata: { message: "המשתמש אישר מעבר לשלב הרינדור", at: new Date().toISOString() }
      }
    });
    return { data: updated };
  });

  app.post("/projects/:projectId/render", async (request, reply) => {
    const params = z.object({ projectId: z.string() }).parse(request.params);
    const tenant = await getDemoTenant();
    const project = await prisma.project.findFirstOrThrow({
      where: { id: params.projectId, tenantId: tenant.id }
    });

    if (project.status !== "RENDER_PACKAGE_APPROVED" || !project.renderPackageApprovedAt) {
      reply.code(409);
      return { error: "יש להשלים ולאשר חבילת חומרים לפני רינדור" };
    }

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

async function analyzeScriptWithFailover(
  input: z.infer<typeof createProjectSchema> & { scenes: Array<{ title: string; narration: string; visualPrompt: string; durationSeconds: number }> },
  scriptProviders: Awaited<ReturnType<typeof prisma.providerCredential.findMany>>,
  logOperation: (step: string, message: string, metadata?: Record<string, unknown>) => void
) {
  if (scriptProviders.length === 0) {
    return analyzeScript({ ...input, onLog: logOperation, provider: null });
  }

  const errors: string[] = [];
  for (const provider of scriptProviders) {
    logOperation("script_analysis_provider_attempt_start", "מנסה לנתח את התסריט עם ספק", {
      provider: provider.provider,
      priority: provider.priority,
      hasKey: Boolean(provider.encryptedKey)
    });

    try {
      const analysis = await analyzeScript({
        ...input,
        onLog: logOperation,
        provider: {
          provider: provider.provider,
          apiKey: provider.encryptedKey ? decryptSecret(provider.encryptedKey) : undefined,
          config: provider.config
        }
      });
      logOperation("script_analysis_provider_attempt_success", "ספק הניתוח החזיר תיק הפקה תקין", {
        provider: provider.provider,
        sceneCount: analysis.scenes.length,
        characterCount: analysis.characters.length
      });
      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown provider error";
      if (!errors.includes(message)) {
        errors.push(message);
      }
      logOperation("script_analysis_provider_attempt_failed", "ספק ניתוח התסריט נכשל, ממשיך לספק הבא אם קיים", {
        provider: provider.provider,
        error: message
      });
    }
  }

  logOperation("script_analysis_fallback_used", "כל ספקי ניתוח התסריט נכשלו; משתמש בניתוח fallback מקומי כדי לא לעצור את התהליך", {
    errors
  });
  return analyzeScript({ ...input, onLog: logOperation, provider: null });
}

function buildEnrichedSourceText(input: z.infer<typeof createProjectSchema>) {
  const sections = [
    input.sourceText.trim(),
    input.supplementalLinks.length
      ? [
        "Additional reference links supplied in Pre-Production:",
        ...input.supplementalLinks.map((link, index) => `${index + 1}. ${link}`)
      ].join("\n")
      : undefined,
    input.supplementalFiles.length
      ? [
        "Uploaded reference files supplied in Pre-Production:",
        ...input.supplementalFiles.map((file, index) => [
          `${index + 1}. ${file.name}`,
          file.mimeType ? `mimeType: ${file.mimeType}` : undefined,
          file.assetType ? `assetType: ${file.assetType}` : undefined,
          file.assetUrl ? `storedUrl: ${file.assetUrl}` : undefined,
          file.extractedText ? `extractedText:\n${file.extractedText.slice(0, 4000)}` : undefined,
          file.imageDataUrl ? "imageReference: attached to the AI request as an inline image; use it as a visual reference." : undefined
        ].filter(Boolean).join("\n"))
      ].join("\n\n")
      : undefined
  ];

  return sections.filter(Boolean).join("\n\n");
}

function createOperationLogger(
  requestLog: { info: (obj: unknown, message: string) => void },
  operationLogs: OperationLog[]
) {
  return (step: string, message: string, metadata?: Record<string, unknown>) => {
    const entry = {
      at: new Date().toISOString(),
      step,
      message,
      metadata
    };
    operationLogs.push(entry);
    requestLog.info({ step, metadata }, message);
  };
}

function findAnalysisScene(scriptAnalysis: Prisma.JsonValue | null, order: number) {
  if (!scriptAnalysis || typeof scriptAnalysis !== "object" || Array.isArray(scriptAnalysis)) {
    return undefined;
  }
  const scenes = (scriptAnalysis as Record<string, unknown>).scenes;
  if (!Array.isArray(scenes)) {
    return undefined;
  }
  return scenes.find((scene) => {
    if (!scene || typeof scene !== "object") {
      return false;
    }
    return Number((scene as Record<string, unknown>).order) === order;
  }) as Record<string, unknown> | undefined;
}

function stringFromRecord(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
