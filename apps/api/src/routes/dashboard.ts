import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/dashboard", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "demo" } });
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [videosThisWeek, distributed, errors, queued, recentJobs] = await Promise.all([
      prisma.project.count({ where: { tenantId: tenant.id, createdAt: { gte: since } } }),
      prisma.renderJob.count({ where: { tenantId: tenant.id, status: "COMPLETED" } }),
      prisma.renderJob.count({ where: { tenantId: tenant.id, status: "FAILED" } }),
      prisma.renderJob.count({ where: { tenantId: tenant.id, status: "QUEUED" } }),
      prisma.renderJob.findMany({
        where: { tenantId: tenant.id },
        include: { project: true },
        orderBy: { updatedAt: "desc" },
        take: 10
      })
    ]);

    return {
      data: {
        stats: { videosThisWeek, distributed, errors, queued },
        recentJobs
      }
    };
  });
}
