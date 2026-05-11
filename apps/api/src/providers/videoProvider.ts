import type { Project, ProviderCredential, Scene } from "@prisma/client";
import { isVideoProviderQuotaOrPlanLimitError } from "@promovid/shared";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { decryptSecret } from "../crypto.js";
import { renderSceneClip } from "../render/ffmpegRenderer.js";

type VideoProviderLog = (step: string, message: string, metadata?: Record<string, unknown>) => Promise<void> | void;
const SHOTSTACK_SEGMENT_SECONDS = 5;

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

  let lastProviderError: string | undefined;
  for (const provider of input.videoProviders) {
    const providerName = provider.provider.toLowerCase();
    await input.onLog?.("video_provider_attempt", "מנסה ליצור וידאו אמיתי דרך ספק VIDEO", {
      sceneId: input.scene.id,
      provider: provider.provider,
      hasKey: Boolean(provider.encryptedKey)
    });

    try {
      const generated = providerName.includes("shotstack")
        ? await generateWithShotstack({
          provider,
          prompt: videoPrompt,
          scene: input.scene,
          project: input.project,
          referenceMediaUrl: input.referenceMediaUrl,
          aspectRatio: input.aspectRatio,
          onLog: input.onLog
        })
        : providerName.includes("runway")
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
      lastProviderError = error instanceof Error ? error.message : String(error);
      await input.onLog?.("video_provider_failed", "ספק VIDEO נכשל, ממשיך לספק הבא או ל-fallback", {
        sceneId: input.scene.id,
        provider: provider.provider,
        error: lastProviderError
      });
    }
  }

  const fallbackReasonBase = input.videoProviders.length === 0
    ? "VIDEO provider missing"
    : "No active VIDEO provider returned a generated clip";
  const allowConfigured = isFfmpegFallbackAllowed(input.videoProviders);
  const allowQuotaAuto = Boolean(lastProviderError && isVideoProviderQuotaOrPlanLimitError(lastProviderError));

  if (!allowConfigured && !allowQuotaAuto) {
    await input.onLog?.("video_provider_missing_or_failed", "לא נוצר וידאו אמיתי ולכן הרינדור נעצר במקום לייצר סרטון טקסט לא קשור", {
      sceneId: input.scene.id,
      fallbackReason: fallbackReasonBase,
      lastProviderError
    });
    const detail = lastProviderError ?? fallbackReasonBase;
    throw new Error(`True video generation failed for scene ${input.scene.order + 1}: ${detail}. Configure an active VIDEO provider with a working endpoint/API key, top up Shotstack credits if you see a plan-limit message, or explicitly enable FFmpeg fallback in the VIDEO provider config with allowFfmpegFallback=true.`);
  }

  if (allowQuotaAuto && !allowConfigured) {
    await input.onLog?.("video_quota_fallback_ffmpeg", "מגבלת ספק חיצוני (קרדיטים/תוכנית); מפעיל קליפ FFmpeg כדי לא לעצור את הרינדור", {
      sceneId: input.scene.id,
      hint: lastProviderError ? String(lastProviderError).slice(0, 400) : undefined
    });
  } else {
    await input.onLog?.("video_provider_missing_or_failed", "לא נוצר וידאו אמיתי; מפעיל fallback ברור של FFmpeg לפי הגדרת ספק", {
      sceneId: input.scene.id,
      fallbackReason: fallbackReasonBase
    });
  }

  const fallbackReason = allowQuotaAuto && !allowConfigured
    ? `VIDEO provider quota/plan limit — automatic FFmpeg fallback (${fallbackReasonBase})`
    : fallbackReasonBase;
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

function isFfmpegFallbackAllowed(videoProviders: ProviderCredential[]) {
  return videoProviders.some((provider) => {
    const config = asRecord(provider.config);
    return config.allowFfmpegFallback === true;
  });
}

export function buildSceneVideoPrompt(project: Project, scene: Scene, referenceMediaUrl?: string) {
  return [
    "Create a new short promotional video clip for this exact scene. The clip must visually tell the scene, not place text over stock footage.",
    `Duration: ${SHOTSTACK_SEGMENT_SECONDS} seconds.`,
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

async function generateWithShotstack(input: {
  provider: ProviderCredential;
  prompt: string;
  scene: Scene;
  project: Project;
  referenceMediaUrl?: string;
  aspectRatio: string;
  onLog?: VideoProviderLog;
}) {
  const apiKey = input.provider.encryptedKey ? decryptSecret(input.provider.encryptedKey) : undefined;
  if (!apiKey) {
    throw new Error("Shotstack provider is missing an API key.");
  }

  const config = asRecord(input.provider.config);
  const configuredBaseUrl = stringConfig(config.baseUrl) ?? stringConfig(config.endpoint);
  const version = stringConfig(config.version) ?? "v1";
  let baseUrl = normalizeShotstackBaseUrl(configuredBaseUrl ?? `https://api.shotstack.io/edit/${version}`);
  const timeoutSeconds = numberConfig(config.timeoutSeconds) ?? 240;
  const voice = stringConfig(config.voice) ?? "Matthew";
  const language = stringConfig(config.language) ?? "en-US";
  const renderLength = SHOTSTACK_SEGMENT_SECONDS;
  const resolutionRaw = stringConfig(config.resolution)?.toLowerCase();
  const resolution = resolutionRaw === "hd" || resolutionRaw === "preview" ? resolutionRaw : "sd";
  const textToSpeech = config.textToSpeech !== false;

  await input.onLog?.("shotstack_render_request_sent", "נשלחה בקשת Shotstack לרינדור מקטע של 5 שניות", {
    provider: input.provider.provider,
    sceneId: input.scene.id,
    renderLength,
    version,
    resolution,
    textToSpeech,
    hasReferenceMedia: Boolean(input.referenceMediaUrl)
  });

  const edit = buildShotstackEdit({
    scene: input.scene,
    referenceMediaUrl: input.referenceMediaUrl,
    aspectRatio: input.aspectRatio,
    length: renderLength,
    voice,
    language,
    resolution,
    textToSpeech
  });
  let { response, payload } = await createShotstackRender({ baseUrl, apiKey, edit });
  if (!response.ok && !configuredBaseUrl && shouldRetryShotstackEnvironment(payload)) {
    const retryVersion = version === "stage" ? "v1" : "stage";
    baseUrl = `https://api.shotstack.io/edit/${retryVersion}`;
    await input.onLog?.("shotstack_render_environment_retry", "Shotstack החזיר שגיאת סביבת API key; מנסה endpoint חלופי", {
      sceneId: input.scene.id,
      originalVersion: version,
      retryVersion
    });
    ({ response, payload } = await createShotstackRender({ baseUrl, apiKey, edit }));
  }
  if (!response.ok) {
    throw new Error(formatShotstackRenderError(response.status, payload));
  }

  const renderId = stringConfig(asRecord(payload.response).id) ?? stringConfig(payload.id);
  if (!renderId) {
    throw new Error(`Shotstack response did not include render id: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  await input.onLog?.("shotstack_render_created", "Shotstack יצר משימת רינדור", {
    sceneId: input.scene.id,
    renderId
  });

  const render = await pollShotstackRender({
    baseUrl,
    apiKey,
    renderId,
    timeoutSeconds,
    onLog: input.onLog
  });
  const generatedVideoUrl = stringConfig(asRecord(render.response).url) ?? stringConfig(render.url);
  if (!generatedVideoUrl) {
    throw new Error(`Shotstack render completed without URL: ${JSON.stringify(render).slice(0, 700)}`);
  }

  const outputPath = await downloadGeneratedVideo({
    projectId: input.project.id,
    sceneOrder: input.scene.order,
    url: generatedVideoUrl,
    onLog: input.onLog
  });

  return { outputPath, generatedVideoUrl };
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
  const timeoutSeconds = numberConfig(config.timeoutSeconds) ?? 120;

  await input.onLog?.("video_provider_request_sent", "נשלחה בקשה ישירה ל-Runway ליצירת וידאו", {
    provider: input.provider.provider,
    sceneId: input.scene.id,
    model,
    ratio,
    duration,
    timeoutSeconds
  });

  const createResponse = await fetchWithTimeout(`${baseUrl}/v1/image_to_video`, {
    method: "POST",
    headers: runwayHeaders(apiKey),
    body: JSON.stringify({
      model,
      promptText: input.prompt,
      ratio,
      duration
    })
  }, 20_000);
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
    const response = await fetchWithTimeout(`${input.baseUrl}/v1/tasks/${input.taskId}`, {
      headers: runwayHeaders(input.apiKey)
    }, 15_000);
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

async function pollShotstackRender(input: {
  baseUrl: string;
  apiKey: string;
  renderId: string;
  timeoutSeconds: number;
  onLog?: VideoProviderLog;
}) {
  const startedAt = Date.now();
  let attempts = 0;

  while (Date.now() - startedAt < input.timeoutSeconds * 1000) {
    attempts += 1;
    const response = await fetchWithTimeout(`${input.baseUrl}/render/${input.renderId}`, {
      headers: {
        accept: "application/json",
        "x-api-key": input.apiKey
      }
    }, 15_000);
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(`Shotstack status polling failed ${response.status}: ${JSON.stringify(payload).slice(0, 700)}`);
    }

    const status = stringConfig(asRecord(payload.response).status) ?? stringConfig(payload.status) ?? "unknown";
    await input.onLog?.("shotstack_render_progress", "בודק סטטוס רינדור Shotstack", {
      renderId: input.renderId,
      status,
      attempts
    });

    if (status === "done") {
      return payload;
    }

    if (["failed", "cancelled", "canceled"].includes(status)) {
      throw new Error(`Shotstack render ${status}: ${JSON.stringify(payload).slice(0, 700)}`);
    }

    await wait(5000);
  }

  throw new Error(`Shotstack render timed out after ${input.timeoutSeconds} seconds`);
}

async function createShotstackRender(input: {
  baseUrl: string;
  apiKey: string;
  edit: Record<string, unknown>;
}) {
  const response = await fetchWithTimeout(`${input.baseUrl}/render`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": input.apiKey
    },
    body: JSON.stringify(input.edit)
  }, 30_000);
  return {
    response,
    payload: await readJson(response)
  };
}

function shouldRetryShotstackEnvironment(payload: Record<string, unknown>) {
  const text = JSON.stringify(payload).toLowerCase();
  return text.includes("production environment")
    || text.includes("sandbox api")
    || text.includes("sandbox environment")
    || text.includes("production api");
}

function formatShotstackRenderError(status: number, payload: Record<string, unknown>) {
  const nested = stringConfig(asRecord(payload.response).error)
    ?? stringConfig(payload.message);
  const text = JSON.stringify(payload);
  const lowerText = text.toLowerCase();
  if (lowerText.includes("credits required") || lowerText.includes("credits left") || lowerText.includes("plan limits")) {
    return [
      `Shotstack (${status}): חסרים קרדיטים או שהגעת למגבלת התוכנית.`,
      nested ? `פירוט: ${nested}` : undefined,
      "פתח Shotstack Dashboard → Subscription והוסף קרדיטים או שדרג תוכנית.",
      text.slice(0, 500)
    ].filter(Boolean).join(" ");
  }
  return nested
    ? `Shotstack render failed (${status}): ${nested}`
    : `Shotstack render request failed ${status}: ${text.slice(0, 700)}`;
}

function buildShotstackEdit(input: {
  scene: Scene;
  referenceMediaUrl?: string;
  aspectRatio: string;
  length: number;
  voice: string;
  language: string;
  resolution: string;
  textToSpeech: boolean;
}) {
  const videoTrack = {
    clips: [
      {
        asset: input.referenceMediaUrl
          ? {
            type: "video",
            src: input.referenceMediaUrl,
            volume: 0
          }
          : {
            type: "html",
            html: `<div style="width:100%;height:100%;background:#111827;"></div>`,
            width: 1080,
            height: 1920
          },
        start: 0,
        length: input.length,
        fit: "crop"
      }
    ]
  };

  const ttsTrack = {
    clips: [
      {
        asset: {
          type: "text-to-speech",
          text: input.scene.narration,
          voice: input.voice,
          language: input.language
        },
        start: 0,
        length: input.length
      }
    ]
  };

  const tracks = input.textToSpeech ? [videoTrack, ttsTrack] : [videoTrack];

  return {
    timeline: {
      background: "#111827",
      tracks
    },
    output: {
      format: "mp4",
      resolution: input.resolution,
      aspectRatio: shotstackAspectRatioFor(input.aspectRatio)
    }
  };
}

function normalizeShotstackBaseUrl(value: string) {
  return value.replace(/\/render\/?$/i, "").replace(/\/$/, "");
}

function shotstackAspectRatioFor(aspectRatio: string) {
  return aspectRatio === "16:9" || aspectRatio === "1:1" ? aspectRatio : "9:16";
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
  const response = await fetchWithTimeout(input.url, {}, 60_000);
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
  if (providerName.includes("shotstack")) {
    return "Set a Shotstack API key in the VIDEO provider. The adapter renders every scene as a 5 second Shotstack render.";
  }
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
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
