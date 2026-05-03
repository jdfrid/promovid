import type { Project, ProviderCredential, Scene } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { decryptSecret } from "../crypto.js";
import { renderSceneClip } from "../render/ffmpegRenderer.js";

type VideoProviderLog = (step: string, message: string, metadata?: Record<string, unknown>) => Promise<void> | void;

export interface SceneVideoResult {
  outputPath: string;
  generatedVideoUrl?: string;
  referenceMediaUrl?: string;
  videoProvider: string;
  videoPrompt: string;
  generationStatus: "generated" | "fallback" | "failed";
  fallbackReason?: string;
}

export async function generateSceneVideo(input: {
  project: Project;
  scene: Scene;
  videoProviders: ProviderCredential[];
  referenceMediaUrl?: string;
  aspectRatio: string;
  onLog?: VideoProviderLog;
}): Promise<SceneVideoResult> {
  const videoPrompt = buildSceneVideoPrompt(input.project, input.scene, input.referenceMediaUrl);
  await input.onLog?.("video_prompt_built", "נבנה prompt ייעודי ליצירת וידאו לסצנה", {
    sceneId: input.scene.id,
    promptPreview: videoPrompt.slice(0, 600),
    referenceMediaUrl: input.referenceMediaUrl
  });

  for (const provider of input.videoProviders) {
    const providerName = provider.provider.toLowerCase();
    await input.onLog?.("video_provider_attempt", "מנסה ליצור וידאו אמיתי דרך ספק VIDEO", {
      sceneId: input.scene.id,
      provider: provider.provider,
      hasKey: Boolean(provider.encryptedKey)
    });

    try {
      const generated = providerName.includes("runway")
        ? await generateWithRunway({
          provider,
          prompt: videoPrompt,
          scene: input.scene,
          project: input.project,
          aspectRatio: input.aspectRatio,
          onLog: input.onLog
        })
        : await generateWithConfiguredEndpoint({
        provider,
        prompt: videoPrompt,
        scene: input.scene,
        project: input.project,
        referenceMediaUrl: input.referenceMediaUrl,
        aspectRatio: input.aspectRatio,
        onLog: input.onLog
      });

      if (generated) {
        return {
          outputPath: generated.outputPath,
          generatedVideoUrl: generated.generatedVideoUrl,
          referenceMediaUrl: input.referenceMediaUrl,
          videoProvider: provider.provider,
          videoPrompt,
          generationStatus: "generated"
        };
      }

      await input.onLog?.("video_provider_deferred", "ספק VIDEO מוגדר אך adapter פעיל דורש endpoint חיצוני בהגדרות", {
        provider: provider.provider,
        supportedHint: videoProviderHint(providerName)
      });
    } catch (error) {
      await input.onLog?.("video_provider_failed", "ספק VIDEO נכשל, ממשיך לספק הבא או ל-fallback", {
        sceneId: input.scene.id,
        provider: provider.provider,
        error: error instanceof Error ? error.message : "unknown video provider error"
      });
    }
  }

  const fallbackReason = input.videoProviders.length === 0
    ? "VIDEO provider missing"
    : "No active VIDEO provider returned a generated clip";
  await input.onLog?.("video_provider_missing_or_failed", "לא נוצר וידאו אמיתי; מפעיל fallback ברור של FFmpeg", {
    sceneId: input.scene.id,
    fallbackReason
  });
  const fallbackClip = await renderSceneClip({
    projectId: input.project.id,
    scene: input.scene,
    aspectRatio: input.aspectRatio,
    mediaUrl: input.referenceMediaUrl,
    onLog: input.onLog,
    fallbackLabel: "FFmpeg fallback placeholder"
  });

  return {
    outputPath: fallbackClip.outputPath,
    generatedVideoUrl: fallbackClip.outputUrl,
    referenceMediaUrl: input.referenceMediaUrl,
    videoProvider: "ffmpeg-fallback",
    videoPrompt,
    generationStatus: "fallback",
    fallbackReason
  };
}

export function buildSceneVideoPrompt(project: Project, scene: Scene, referenceMediaUrl?: string) {
  return [
    "Create a new short promotional video clip for this exact scene. The clip must visually tell the scene, not place text over stock footage.",
    `Duration: ${scene.durationSeconds} seconds.`,
    `Aspect ratio: ${project.aspectRatio}.`,
    project.style ? `Style: ${project.style}.` : undefined,
    project.targetAudience ? `Target audience: ${project.targetAudience}.` : undefined,
    `Project title: ${project.title}.`,
    `Source/product instructions: ${project.sourceText}`,
    project.backgroundVideoPrompt ? `Overall background video direction: ${project.backgroundVideoPrompt}` : undefined,
    `Scene title: ${scene.title}.`,
    `Scene narration/action: ${scene.narration}`,
    `Scene visual prompt: ${scene.visualPrompt}`,
    referenceMediaUrl ? `Use this reference media only as inspiration/source reference, not as the final unchanged footage: ${referenceMediaUrl}` : undefined,
    "Include cinematic camera movement, lighting, mood, composition, and product-focused action.",
    "Do not burn visible text into the video unless explicitly required by the scene."
  ].filter(Boolean).join("\n");
}

async function generateWithRunway(input: {
  provider: ProviderCredential;
  prompt: string;
  scene: Scene;
  project: Project;
  aspectRatio: string;
  onLog?: VideoProviderLog;
}) {
  const apiKey = input.provider.encryptedKey ? decryptSecret(input.provider.encryptedKey) : undefined;
  if (!apiKey) {
    throw new Error("Runway provider is missing an API key.");
  }

  const config = asRecord(input.provider.config);
  const baseUrl = stringConfig(config.baseUrl) ?? "https://api.dev.runwayml.com";
  const model = stringConfig(config.model) ?? "gen4.5";
  const ratio = stringConfig(config.ratio) ?? runwayRatioFor(input.aspectRatio);
  const duration = numberConfig(config.durationSeconds) ?? Math.min(10, Math.max(2, Math.round(input.scene.durationSeconds)));
  const timeoutSeconds = numberConfig(config.timeoutSeconds) ?? 600;

  await input.onLog?.("video_provider_request_sent", "נשלחה בקשה ישירה ל-Runway ליצירת וידאו", {
    provider: input.provider.provider,
    sceneId: input.scene.id,
    model,
    ratio,
    duration,
    timeoutSeconds
  });

  const createResponse = await fetch(`${baseUrl}/v1/image_to_video`, {
    method: "POST",
    headers: runwayHeaders(apiKey),
    body: JSON.stringify({
      model,
      promptText: input.prompt,
      ratio,
      duration
    })
  });
  const createPayload = await readJson(createResponse);
  if (!createResponse.ok) {
    throw new Error(`Runway create task failed ${createResponse.status}: ${JSON.stringify(createPayload).slice(0, 700)}`);
  }

  const taskId = stringConfig(createPayload.id);
  if (!taskId) {
    throw new Error(`Runway create task response did not include id: ${JSON.stringify(createPayload).slice(0, 500)}`);
  }

  await input.onLog?.("video_provider_task_created", "Runway התחיל משימת יצירת וידאו", {
    provider: input.provider.provider,
    sceneId: input.scene.id,
    taskId
  });

  const task = await pollRunwayTask({
    baseUrl,
    apiKey,
    taskId,
    timeoutSeconds,
    onLog: input.onLog
  });
  const generatedVideoUrl = extractTaskOutputUrl(task);
  if (!generatedVideoUrl) {
    throw new Error(`Runway task completed without output video URL: ${JSON.stringify(task).slice(0, 700)}`);
  }

  const outputPath = await downloadGeneratedVideo({
    projectId: input.project.id,
    sceneOrder: input.scene.order,
    url: generatedVideoUrl,
    onLog: input.onLog
  });

  return { outputPath, generatedVideoUrl };
}

async function generateWithConfiguredEndpoint(input: {
  provider: ProviderCredential;
  prompt: string;
  scene: Scene;
  project: Project;
  referenceMediaUrl?: string;
  aspectRatio: string;
  onLog?: VideoProviderLog;
}) {
  const config = asRecord(input.provider.config);
  const endpoint = stringConfig(config.endpoint) ?? stringConfig(config.apiEndpoint) ?? stringConfig(config.webhookUrl);
  if (!endpoint) {
    return undefined;
  }

  const apiKey = input.provider.encryptedKey ? decryptSecret(input.provider.encryptedKey) : undefined;
  const controller = new AbortController();
  const timeoutSeconds = numberConfig(config.timeoutSeconds) ?? 180;
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    await input.onLog?.("video_provider_request_sent", "נשלחה בקשה לספק VIDEO", {
      provider: input.provider.provider,
      endpoint,
      sceneId: input.scene.id,
      timeoutSeconds
    });

    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        prompt: input.prompt,
        referenceMediaUrl: input.referenceMediaUrl,
        durationSeconds: input.scene.durationSeconds,
        aspectRatio: input.aspectRatio,
        sceneId: input.scene.id,
        projectId: input.project.id,
        provider: input.provider.provider
      })
    });

    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(`VIDEO provider returned ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
    }

    const generatedVideoUrl = extractVideoUrl(payload);
    if (!generatedVideoUrl) {
      throw new Error("VIDEO provider response did not include videoUrl/url/outputUrl.");
    }

    await input.onLog?.("video_provider_response_received", "ספק VIDEO החזיר קישור לקליפ שנוצר", {
      provider: input.provider.provider,
      sceneId: input.scene.id,
      generatedVideoUrl
    });

    const outputPath = await downloadGeneratedVideo({
      projectId: input.project.id,
      sceneOrder: input.scene.order,
      url: generatedVideoUrl,
      onLog: input.onLog
    });

    return { outputPath, generatedVideoUrl };
  } finally {
    clearTimeout(timeout);
  }
}

async function pollRunwayTask(input: {
  baseUrl: string;
  apiKey: string;
  taskId: string;
  timeoutSeconds: number;
  onLog?: VideoProviderLog;
}) {
  const startedAt = Date.now();
  let attempts = 0;

  while (Date.now() - startedAt < input.timeoutSeconds * 1000) {
    attempts += 1;
    const response = await fetch(`${input.baseUrl}/v1/tasks/${input.taskId}`, {
      headers: runwayHeaders(input.apiKey)
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(`Runway task polling failed ${response.status}: ${JSON.stringify(payload).slice(0, 700)}`);
    }

    const status = stringConfig(payload.status) ?? "UNKNOWN";
    await input.onLog?.("video_provider_task_progress", "בודק סטטוס משימת Runway", {
      taskId: input.taskId,
      status,
      attempts
    });

    if (status === "SUCCEEDED") {
      return payload;
    }

    if (["FAILED", "CANCELLED", "CANCELED"].includes(status)) {
      throw new Error(`Runway task ${status}: ${JSON.stringify(payload).slice(0, 700)}`);
    }

    await wait(5000);
  }

  throw new Error(`Runway task timed out after ${input.timeoutSeconds} seconds`);
}

async function downloadGeneratedVideo(input: {
  projectId: string;
  sceneOrder: number;
  url: string;
  onLog?: VideoProviderLog;
}) {
  const outputDirectory = path.resolve("./renders");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${input.projectId}-generated-scene-${input.sceneOrder + 1}-${nanoid(8)}.mp4`);
  const response = await fetch(input.url);
  if (!response.ok) {
    throw new Error(`Could not download generated video ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, buffer);
  await input.onLog?.("video_provider_file_downloaded", "הקליפ שנוצר ירד ונשמר זמנית לקראת שמירה במסד הנתונים", {
    outputPath,
    sizeBytes: buffer.byteLength
  });
  return outputPath;
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function extractVideoUrl(payload: Record<string, unknown>) {
  return stringConfig(payload.videoUrl)
    ?? stringConfig(payload.fileUrl)
    ?? stringConfig(payload.outputUrl)
    ?? stringConfig(payload.url)
    ?? stringConfig(asRecord(payload.data).videoUrl)
    ?? stringConfig(asRecord(payload.data).url);
}

function extractTaskOutputUrl(payload: Record<string, unknown>) {
  const output = payload.output;
  if (Array.isArray(output)) {
    return output.map((item) => stringConfig(item)).find(Boolean);
  }

  return stringConfig(output)
    ?? stringConfig(payload.videoUrl)
    ?? stringConfig(payload.url);
}

function videoProviderHint(providerName: string) {
  if (providerName.includes("gemini") || providerName.includes("veo")) {
    return "Gemini/Veo adapter is available through a configured endpoint/webhookUrl until direct Veo API is enabled.";
  }
  if (providerName.includes("runway") || providerName.includes("kling")) {
    return "Set config.endpoint or config.webhookUrl to a service that returns { videoUrl }.";
  }
  return "Set config.endpoint or config.webhookUrl to a service that accepts prompt/referenceMediaUrl and returns { videoUrl }.";
}

function runwayHeaders(apiKey: string) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "x-runway-version": "2024-11-06"
  };
}

function runwayRatioFor(aspectRatio: string) {
  if (aspectRatio === "16:9") {
    return "1280:720";
  }
  if (aspectRatio === "1:1") {
    return "960:960";
  }
  return "720:1280";
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringConfig(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberConfig(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
