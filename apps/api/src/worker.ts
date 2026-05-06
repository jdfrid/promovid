import { Worker } from "bullmq";
import type { Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RenderJobPayload } from "@promovid/shared";
import { prisma } from "./db.js";
import { redisConnection } from "./queue.js";
import { addAudioToClip, mergeSceneClips } from "./render/ffmpegRenderer.js";
import { generateSceneVideo } from "./providers/videoProvider.js";

type WorkerLog = { at: string; step: string; message: string; metadata?: Record<string, unknown> };

export async function processRenderJob(data: RenderJobPayload, updateProgress?: (progress: number) => Promise<void> | void) {
    const { jobId, projectId } = data;
    const logs: WorkerLog[] = [];
    const log = async (step: string, message: string, metadata?: Record<string, unknown>) => {
      const metadataWithProject = { projectId, ...(metadata ?? {}) };
      const entry = { at: new Date().toISOString(), step, message, metadata: metadataWithProject };
      logs.push(entry);
      console.log(`[render:${jobId}] ${step} ${message}`, metadataWithProject);
      await prisma.auditLog.create({
        data: {
          tenantId: data.tenantId,
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

    if (!project.renderPackageApprovedAt || !project.renderPackage) {
      throw new Error("Render package must be approved before rendering");
    }

    await log("render_package_loaded", "נקראה חבילת החומרים המאושרת לפני רינדור", {
      projectId,
      approvedAt: project.renderPackageApprovedAt.toISOString()
    });

    const providers = await prisma.providerCredential.findMany({
      where: {
        tenantId: data.tenantId,
        enabled: true,
        OR: [
          { type: "VIDEO" },
          { type: "MERGE", provider: { contains: "shotstack", mode: "insensitive" } }
        ]
      },
      orderBy: [{ type: "asc" }, { priority: "asc" }]
    });
    const shotstackProviders = orderVideoProviders(providers.filter((provider) => provider.provider.toLowerCase().includes("shotstack")));
    const ignoredVideoProviders = providers.filter((provider) => provider.type === "VIDEO" && !provider.provider.toLowerCase().includes("shotstack"));
    const providersByType = {
      VIDEO: shotstackProviders
    };

    await log("providers_loaded", "נטענו ספקי וידאו פעילים לשלב הרינדור", {
      video: providersByType.VIDEO.length,
      selectedRenderer: "shotstack",
      providers: providersByType.VIDEO.map((provider) => ({
        type: provider.type,
        provider: provider.provider,
        priority: provider.priority,
        hasKey: Boolean(provider.encryptedKey)
      })),
      ignoredVideoProviders: ignoredVideoProviders.map((provider) => provider.provider)
    });

    const orderedScenes = [...project.scenes].sort((a, b) => a.order - b.order);
    const renderedClipPaths: string[] = [];
    for (const [index, scene] of orderedScenes.entries()) {
      const baseProgress = 10 + Math.round((index / Math.max(orderedScenes.length, 1)) * 70);
      await prisma.renderJob.update({
        where: { id: jobId },
        data: { progress: baseProgress, stage: `scene_${index + 1}_package_assets` }
      });
      await log("scene_package_assets_loaded", "קורא חומרים שנאספו מראש עבור הסצנה", {
        sceneId: scene.id,
        scene: index + 1,
        mediaUrl: scene.referenceMediaUrl ?? scene.mediaUrl,
        voiceUrl: scene.voiceUrl,
        musicUrl: scene.musicUrl
      });

      await prisma.renderJob.update({
        where: { id: jobId },
        data: { progress: Math.min(baseProgress + 8, 85), stage: `scene_${index + 1}_video_generation` }
      });
      await log("scene_video_generation_started", "מתחיל יצירת קליפ וידאו חדש לסצנה", { sceneId: scene.id, scene: index + 1 });
      const clip = await withStageTimeout(
        generateSceneVideo({
          project,
          scene,
          videoProviders: providersByType.VIDEO,
          referenceMediaUrl: scene.referenceMediaUrl ?? scene.mediaUrl ?? undefined,
          aspectRatio: project.aspectRatio,
          onLog: log
        }),
        150_000,
        `Scene ${index + 1} video generation timed out after 150 seconds`
      );
      const clipWithAudioPath = await addAudioToClip({
        projectId: project.id,
        scene,
        videoPath: clip.outputPath,
        musicUrl: scene.musicUrl,
        voiceUrl: scene.voiceUrl,
        onLog: log
      });
      renderedClipPaths.push(clipWithAudioPath);
      const clipFile = await storeRenderFile({
        tenantId: data.tenantId,
        projectId: project.id,
        sceneId: scene.id,
        renderJobId: jobId,
        filePath: clipWithAudioPath
      });

      await prisma.scene.update({
        where: { id: scene.id },
        data: {
          clipUrl: `/api/render-files/${clipFile.id}`,
          referenceMediaUrl: clip.referenceMediaUrl,
          generatedVideoUrl: clip.generatedVideoUrl ?? `/api/render-files/${clipFile.id}`,
          videoProvider: clip.videoProvider,
          videoPrompt: clip.videoPrompt,
          generationStatus: clip.generationStatus,
          renderLog: {
            packageAssets: {
              mediaUrl: scene.referenceMediaUrl ?? scene.mediaUrl,
              voiceUrl: scene.voiceUrl,
              musicUrl: scene.musicUrl
            },
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
      tenantId: data.tenantId,
      projectId: project.id,
      renderJobId: jobId,
      filePath: output.outputPath
    });

    await updateProgress?.(90);

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
}

const worker = new Worker<RenderJobPayload>(
  "render-jobs",
  async (job) => processRenderJob(job.data, (progress) => job.updateProgress(progress)),
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

function orderVideoProviders<T extends { provider: string; priority: number }>(providers: T[]) {
  return [...providers].sort((left, right) => {
    const leftIsShotstack = left.provider.toLowerCase().includes("shotstack");
    const rightIsShotstack = right.provider.toLowerCase().includes("shotstack");
    if (leftIsShotstack !== rightIsShotstack) {
      return leftIsShotstack ? -1 : 1;
    }
    return left.priority - right.priority;
  });
}

async function withStageTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
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
