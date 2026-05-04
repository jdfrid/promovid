import type { Prisma, Project, Scene } from "@prisma/client";
import { prisma } from "../db.js";

type ProjectWithScenes = Project & { scenes: Scene[] };

interface PackageFile {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
}

export interface RenderPackageResult {
  version: 1;
  projectId: string;
  createdAt: string;
  status: "ready";
  files: {
    manifest: PackageFile;
    instructions: PackageFile;
    timeline: PackageFile;
  };
  manifest: Record<string, unknown>;
  instructions: string;
  timeline: Record<string, unknown>;
  missingAssets: Array<{ sceneId: string; sceneOrder: number; missing: string[] }>;
}

export function buildMaterialLibrary(project: ProjectWithScenes, scriptAnalysis: unknown) {
  const scenes = [...project.scenes].sort((a, b) => a.order - b.order);
  return {
    projectId: project.id,
    createdAt: new Date().toISOString(),
    status: "ready",
    scriptAnalysis,
    assets: scenes.map((scene) => ({
      sceneId: scene.id,
      sceneOrder: scene.order,
      title: scene.title,
      background: {
        url: scene.referenceMediaUrl ?? scene.mediaUrl,
        prompt: scene.visualPrompt,
        providerStatus: scene.mediaUrl ? "ready" : "missing"
      },
      avatar: {
        url: null,
        prompt: scene.renderLog && typeof scene.renderLog === "object" ? readNestedString(scene.renderLog, ["analysis", "avatarPrompt"]) : undefined,
        providerStatus: "planned"
      },
      voice: {
        url: scene.voiceUrl,
        prompt: scene.narration,
        providerStatus: scene.voiceUrl ? "ready" : "missing"
      },
      music: {
        url: scene.musicUrl,
        prompt: project.musicPrompt,
        providerStatus: scene.musicUrl ? "ready" : "missing"
      }
    }))
  };
}

export async function buildAndStoreRenderPackage(input: {
  tenantId: string;
  project: ProjectWithScenes;
}): Promise<RenderPackageResult> {
  const scenes = [...input.project.scenes].sort((a, b) => a.order - b.order);
  const scriptAnalysis = asRecord(input.project.scriptAnalysis);
  const materialLibrary = asRecord(input.project.materialLibrary);
  const missingAssets = scenes.map((scene) => ({
    sceneId: scene.id,
    sceneOrder: scene.order,
    missing: [
      scene.mediaUrl || scene.referenceMediaUrl ? undefined : "background/reference media",
      scene.voiceUrl ? undefined : "voice/dialogue audio",
      scene.musicUrl ? undefined : "music"
    ].filter(Boolean) as string[]
  })).filter((entry) => entry.missing.length > 0);

  const timeline = {
    projectId: input.project.id,
    title: input.project.title,
    duration: input.project.duration,
    aspectRatio: input.project.aspectRatio,
    generatedAt: new Date().toISOString(),
    scenes: scenes.map((scene) => {
      const analysisScene = findAnalysisScene(scriptAnalysis, scene.order);
      return {
        sceneId: scene.id,
        order: scene.order,
        title: scene.title,
        durationSeconds: scene.durationSeconds,
        narration: scene.narration,
        visualPrompt: scene.visualPrompt,
        timeline: analysisScene?.timeline ?? [
          {
            startSecond: 0,
            endSecond: scene.durationSeconds,
            action: scene.visualPrompt,
            dialogue: scene.narration,
            speaker: "Narrator",
            requiredAssets: ["backgroundVideo", "voice", "music"]
          }
        ],
        assets: {
          background: scene.referenceMediaUrl ?? scene.mediaUrl ?? null,
          voice: scene.voiceUrl ?? null,
          music: scene.musicUrl ?? null,
          generatedVideo: scene.generatedVideoUrl ?? null
        }
      };
    })
  };

  const manifest = {
    project: {
      id: input.project.id,
      title: input.project.title,
      sourceText: input.project.sourceText,
      targetAudience: input.project.targetAudience,
      style: input.project.style,
      duration: input.project.duration,
      aspectRatio: input.project.aspectRatio,
      backgroundVideoPrompt: input.project.backgroundVideoPrompt,
      musicPrompt: input.project.musicPrompt
    },
    scriptAnalysis,
    materialLibrary,
    missingAssets,
    timeline
  };

  const instructions = buildInstructions(input.project, manifest, timeline);
  const [manifestFile, instructionsFile, timelineFile] = await Promise.all([
    storePackageFile(input.tenantId, input.project.id, "manifest.json", "application/json", JSON.stringify(manifest, null, 2)),
    storePackageFile(input.tenantId, input.project.id, "instructions.md", "text/markdown", instructions),
    storePackageFile(input.tenantId, input.project.id, "timeline.json", "application/json", JSON.stringify(timeline, null, 2))
  ]);

  return {
    version: 1,
    projectId: input.project.id,
    createdAt: new Date().toISOString(),
    status: "ready",
    files: {
      manifest: manifestFile,
      instructions: instructionsFile,
      timeline: timelineFile
    },
    manifest,
    instructions,
    timeline,
    missingAssets
  };
}

function buildInstructions(project: ProjectWithScenes, manifest: Record<string, unknown>, timeline: Record<string, unknown>) {
  return [
    `# Render Instructions: ${project.title}`,
    "",
    "Create the final promotional video from the approved production package.",
    "",
    "## Project Context",
    `- Duration: ${project.duration} seconds`,
    `- Aspect ratio: ${project.aspectRatio}`,
    project.style ? `- Style: ${project.style}` : undefined,
    project.targetAudience ? `- Target audience: ${project.targetAudience}` : undefined,
    project.backgroundVideoPrompt ? `- Background direction: ${project.backgroundVideoPrompt}` : undefined,
    project.musicPrompt ? `- Music direction: ${project.musicPrompt}` : undefined,
    "",
    "## Required Behavior",
    "- Follow the timeline exactly.",
    "- Use the supplied reference media as production context, not as unchanged filler footage.",
    "- Match every scene to its narration, visual action, dialogue and music direction.",
    "- Keep the same story continuity across scenes.",
    "- Do not add visible text unless the scene explicitly requires it.",
    "",
    "## Timeline",
    "```json",
    JSON.stringify(timeline, null, 2),
    "```",
    "",
    "## Manifest",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```"
  ].filter((line) => line !== undefined).join("\n");
}

async function storePackageFile(tenantId: string, projectId: string, filename: string, mimeType: string, content: string): Promise<PackageFile> {
  const data = Buffer.from(content, "utf8");
  const file = await prisma.renderFile.create({
    data: {
      tenantId,
      projectId,
      filename: `${projectId}-${filename}`,
      mimeType,
      sizeBytes: data.byteLength,
      data
    },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      sizeBytes: true
    }
  });

  return {
    ...file,
    url: `/api/render-files/${file.id}`
  };
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function findAnalysisScene(scriptAnalysis: Record<string, unknown>, order: number) {
  const scenes = Array.isArray(scriptAnalysis.scenes) ? scriptAnalysis.scenes : [];
  return scenes.find((scene) => {
    if (!scene || typeof scene !== "object") {
      return false;
    }
    return Number((scene as Record<string, unknown>).order) === order;
  }) as Record<string, unknown> | undefined;
}

function readNestedString(value: object, path: string[]) {
  let current: unknown = value;
  for (const part of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}
