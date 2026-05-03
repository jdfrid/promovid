import { Worker } from "bullmq";
import type { Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RenderJobPayload } from "@promovid/shared";
import { prisma } from "./db.js";
import { redisConnection } from "./queue.js";
import { mergeSceneClips } from "./render/ffmpegRenderer.js";
import { collectSceneAssets } from "./providers/assetProvider.js";
import { generateSceneVideo } from "./providers/videoProvider.js";

type WorkerLog = { at: string; step: string; message: string; metadata?: Record<string, unknown> };

const worker = new Worker<RenderJobPayload>(
  "render-jobs",
  async (job) => {
    const { jobId, projectId } = job.data;
    const logs: WorkerLog[] = [];
    const log = async (step: string, message: string, metadata?: Record<string, unknown>) => {
      const metadataWithProject = { projectId, ...(metadata ?? {}) };
      const entry = { at: new Date().toISOString(), step, message, metadata: metadataWithProject };
      logs.push(entry);
      console.log(`[render:${jobId}] ${step} ${message}`, metadataWithProject);
      await prisma.auditLog.create({
        data: {
          tenantId: job.data.tenantId,
          action: step,
          entity: "RenderJob",
          entityId: jobId,
          metadata: { message, at: entry.at, ...metadataWithProject }
        }
      });
    };

    await prisma.renderJob.update({
      where: { id: jobId },
      data: { status: "RUNNING", progress: 5, stage: "collect_assets" }
    });
    await log("render_job_started", "התחיל תהליך הפקת הסרטונים", { projectId });

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { scenes: true }
    });

    if (!project) {
      throw new Error(`Project ${projectId} was not found`);
    }

    const providers = await prisma.providerCredential.findMany({
      where: {
        tenantId: job.data.tenantId,
        type: { in: ["MEDIA", "VOICE", "MUSIC", "VIDEO"] },
        enabled: true
      },
      orderBy: [{ type: "asc" }, { priority: "asc" }]
    });
    const providersByType = {
      MEDIA: providers.filter((provider) => provider.type === "MEDIA"),
      VOICE: providers.filter((provider) => provider.type === "VOICE"),
      MUSIC: providers.filter((provider) => provider.type === "MUSIC"),
      VIDEO: providers.filter((provider) => provider.type === "VIDEO")
    };

    await log("providers_loaded", "נטענו ספקי מדיה/קול/מוסיקה/וידאו פעילים", {
      media: providersByType.MEDIA.length,
      voice: providersByType.VOICE.length,
      music: providersByType.MUSIC.length,
      video: providersByType.VIDEO.length
    });

    const orderedScenes = [...project.scenes].sort((a, b) => a.order - b.order);
    const renderedClipPaths: string[] = [];
    for (const [index, scene] of orderedScenes.entries()) {
      const baseProgress = 10 + Math.round((index / Math.max(orderedScenes.length, 1)) * 70);
      await prisma.renderJob.update({
        where: { id: jobId },
        data: { progress: baseProgress, stage: `scene_${index + 1}_assets` }
      });
      await log("scene_assets_started", "מתחיל איסוף מרכיבים לסצנה", { sceneId: scene.id, scene: index + 1 });

      const assets = await collectSceneAssets(scene, providersByType, {
        backgroundVideoPrompt: project.backgroundVideoPrompt,
        musicPrompt: project.musicPrompt
      });
      for (const assetLog of assets.log) {
        await log(assetLog.step, assetLog.message, assetLog.metadata);
      }

      await prisma.renderJob.update({
        where: { id: jobId },
        data: { progress: Math.min(baseProgress + 8, 85), stage: `scene_${index + 1}_video_generation` }
      });
      await log("scene_video_generation_started", "מתחיל יצירת קליפ וידאו חדש לסצנה", { sceneId: scene.id, scene: index + 1 });
      const clip = await generateSceneVideo({
        project,
        scene,
        videoProviders: providersByType.VIDEO,
        referenceMediaUrl: assets.mediaUrl,
        aspectRatio: project.aspectRatio,
        onLog: log
      });
      renderedClipPaths.push(clip.outputPath);
      const clipFile = await storeRenderFile({
        tenantId: job.data.tenantId,
        projectId: project.id,
        sceneId: scene.id,
        renderJobId: jobId,
        filePath: clip.outputPath
      });

      await prisma.scene.update({
        where: { id: scene.id },
        data: {
          mediaUrl: assets.mediaUrl,
          voiceUrl: assets.voiceUrl,
          musicUrl: assets.musicUrl,
          clipUrl: `/api/render-files/${clipFile.id}`,
          referenceMediaUrl: clip.referenceMediaUrl,
          generatedVideoUrl: clip.generatedVideoUrl ?? `/api/render-files/${clipFile.id}`,
          videoProvider: clip.videoProvider,
          videoPrompt: clip.videoPrompt,
          generationStatus: clip.generationStatus,
          renderLog: {
            logs: assets.log,
            video: {
              provider: clip.videoProvider,
              prompt: clip.videoPrompt,
              referenceMediaUrl: clip.referenceMediaUrl,
              generatedVideoUrl: clip.generatedVideoUrl,
              generationStatus: clip.generationStatus,
              fallbackReason: clip.fallbackReason
            }
          } as Prisma.InputJsonValue
        }
      });
      await log("scene_video_generation_completed", "קליפ הסצנה מוכן להורדה", {
        sceneId: scene.id,
        scene: index + 1,
        videoProvider: clip.videoProvider,
        generationStatus: clip.generationStatus,
        clipUrl: `/api/render-files/${clipFile.id}`,
        sizeBytes: clipFile.sizeBytes
      });
    }

    await prisma.renderJob.update({
      where: { id: jobId },
      data: { progress: 88, stage: "merge_final_video" }
    });
    await log("final_render_started", "מרנדר סרטון סופי מאוחד", { sceneCount: orderedScenes.length });

    const output = await mergeSceneClips({
      projectId: project.id,
      clipPaths: renderedClipPaths,
      onLog: log
    });
    const finalFile = await storeRenderFile({
      tenantId: job.data.tenantId,
      projectId: project.id,
      renderJobId: jobId,
      filePath: output.outputPath
    });

    await job.updateProgress(90);

    await prisma.$transaction([
      prisma.renderJob.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          progress: 100,
          outputUrl: `/api/render-files/${finalFile.id}`,
          stage: "completed"
        }
      }),
      prisma.project.update({
        where: { id: project.id },
        data: { status: "COMPLETED" }
      })
    ]);
    await log("render_job_completed", "כל הסרטונים מוכנים להורדה", {
      outputUrl: `/api/render-files/${finalFile.id}`,
      sizeBytes: finalFile.sizeBytes
    });
  },
  {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 10 * 60 * 1000,
    stalledInterval: 2 * 60 * 1000,
    maxStalledCount: 3
  }
);

worker.on("failed", async (job, error) => {
  if (!job) {
    return;
  }

  await prisma.renderJob.update({
    where: { id: job.data.jobId },
    data: {
      status: "FAILED",
      error: error.message,
      progress: 100
    }
  });
  await prisma.project.update({
    where: { id: job.data.projectId },
    data: { status: "FAILED" }
  });
  await prisma.auditLog.create({
    data: {
      tenantId: job.data.tenantId,
      action: "render_job_failed",
      entity: "RenderJob",
      entityId: job.data.jobId,
      metadata: { message: error.message, at: new Date().toISOString(), projectId: job.data.projectId }
    }
  });
});

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`AdBot render worker received ${signal}, shutting down gracefully`);

  try {
    await worker.close();
    await redisConnection.quit();
    await prisma.$disconnect();
    process.exit(0);
  } catch (error) {
    console.error("AdBot render worker shutdown failed", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

console.log("AdBot render worker is running");

async function storeRenderFile(input: {
  tenantId: string;
  projectId: string;
  sceneId?: string;
  renderJobId?: string;
  filePath: string;
}) {
  const data = await readFile(input.filePath);
  return prisma.renderFile.create({
    data: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      sceneId: input.sceneId,
      renderJobId: input.renderJobId,
      filename: path.basename(input.filePath),
      mimeType: "video/mp4",
      sizeBytes: data.byteLength,
      data
    },
    select: {
      id: true,
      sizeBytes: true
    }
  });
}
