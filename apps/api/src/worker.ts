import { Worker } from "bullmq";
import type { Prisma } from "@prisma/client";
import type { RenderJobPayload } from "@promovid/shared";
import { prisma } from "./db.js";
import { redisConnection } from "./queue.js";
import { renderSceneClip, renderVideo } from "./render/ffmpegRenderer.js";
import { collectSceneAssets } from "./providers/assetProvider.js";

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
        type: { in: ["MEDIA", "VOICE", "MUSIC"] },
        enabled: true
      },
      orderBy: [{ type: "asc" }, { priority: "asc" }]
    });
    const providersByType = {
      MEDIA: providers.filter((provider) => provider.type === "MEDIA"),
      VOICE: providers.filter((provider) => provider.type === "VOICE"),
      MUSIC: providers.filter((provider) => provider.type === "MUSIC")
    };

    await log("providers_loaded", "נטענו ספקי מדיה/קול/מוסיקה פעילים", {
      media: providersByType.MEDIA.length,
      voice: providersByType.VOICE.length,
      music: providersByType.MUSIC.length
    });

    const orderedScenes = [...project.scenes].sort((a, b) => a.order - b.order);
    for (const [index, scene] of orderedScenes.entries()) {
      const baseProgress = 10 + Math.round((index / Math.max(orderedScenes.length, 1)) * 70);
      await prisma.renderJob.update({
        where: { id: jobId },
        data: { progress: baseProgress, stage: `scene_${index + 1}_assets` }
      });
      await log("scene_assets_started", "מתחיל איסוף מרכיבים לסצנה", { sceneId: scene.id, scene: index + 1 });

      const assets = await collectSceneAssets(scene, providersByType);
      for (const assetLog of assets.log) {
        await log(assetLog.step, assetLog.message, assetLog.metadata);
      }

      await prisma.renderJob.update({
        where: { id: jobId },
        data: { progress: Math.min(baseProgress + 8, 85), stage: `scene_${index + 1}_render` }
      });
      await log("scene_render_started", "מרנדר קליפ MP4 לסצנה", { sceneId: scene.id, scene: index + 1 });
      const clip = await renderSceneClip({
        projectId: project.id,
        scene,
        aspectRatio: project.aspectRatio,
        mediaUrl: assets.mediaUrl
      });

      await prisma.scene.update({
        where: { id: scene.id },
        data: {
          mediaUrl: assets.mediaUrl,
          voiceUrl: assets.voiceUrl,
          musicUrl: assets.musicUrl,
          clipUrl: clip.outputUrl,
          renderLog: { logs: assets.log } as Prisma.InputJsonValue
        }
      });
      await log("scene_render_completed", "קליפ הסצנה מוכן להורדה", {
        sceneId: scene.id,
        scene: index + 1,
        clipUrl: clip.outputUrl
      });
    }

    await prisma.renderJob.update({
      where: { id: jobId },
      data: { progress: 88, stage: "merge_final_video" }
    });
    await log("final_render_started", "מרנדר סרטון סופי מאוחד", { sceneCount: orderedScenes.length });

    const output = await renderVideo({
      projectId: project.id,
      title: project.title,
      aspectRatio: project.aspectRatio,
      scenes: orderedScenes
    });

    await job.updateProgress(90);

    await prisma.$transaction([
      prisma.renderJob.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          progress: 100,
          outputUrl: output.outputUrl,
          stage: "completed"
        }
      }),
      prisma.project.update({
        where: { id: project.id },
        data: { status: "COMPLETED" }
      })
    ]);
    await log("render_job_completed", "כל הסרטונים מוכנים להורדה", { outputUrl: output.outputUrl });
  },
  { connection: redisConnection, concurrency: 2 }
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

console.log("AdBot render worker is running");
