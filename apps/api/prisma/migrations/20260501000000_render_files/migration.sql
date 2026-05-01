CREATE TABLE "RenderFile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sceneId" TEXT,
    "renderJobId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RenderFile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RenderFile_tenantId_projectId_idx" ON "RenderFile"("tenantId", "projectId");
CREATE INDEX "RenderFile_renderJobId_idx" ON "RenderFile"("renderJobId");
CREATE INDEX "RenderFile_sceneId_idx" ON "RenderFile"("sceneId");
