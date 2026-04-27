import { Worker } from "bullmq";
import type { RenderJobPayload } from "@promovid/shared";
import { prisma } from "./db.js";
import { redisConnection } from "./queue.js";
import { renderVideo } from "./render/ffmpegRenderer.js";

const worker = new Worker<RenderJobPayload>(
  "render-jobs",
  async (job) => {
    const { jobId, projectId } = job.data;

    await prisma.renderJob.update({
      where: { id: jobId },
      data: { status: "RUNNING", progress: 10, stage: "render" }
    });

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { scenes: true }
    });

    if (!project) {
      throw new Error(`Project ${projectId} was not found`);
    }

    await job.updateProgress(35);

    const output = await renderVideo({
      projectId: project.id,
      title: project.title,
      aspectRatio: project.aspectRatio,
      scenes: project.scenes
    });

    await job.updateProgress(90);

    await prisma.$transaction([
      prisma.renderJob.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          progress: 100,
          outputUrl: output.outputUrl,
          stage: "storage"
        }
      }),
      prisma.project.update({
        where: { id: project.id },
        data: { status: "COMPLETED" }
      })
    ]);
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
});

console.log("AdBot render worker is running");
