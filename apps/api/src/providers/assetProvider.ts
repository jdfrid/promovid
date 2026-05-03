import type { ProviderCredential, Scene } from "@prisma/client";
import type { OpenverseAudioDetail } from "@openverse/api-client";
import { OpenverseClient } from "@openverse/api-client";
import { decryptSecret } from "../crypto.js";

export interface SceneAssets {
  mediaUrl?: string;
  voiceUrl?: string;
  musicUrl?: string;
  log: Array<{ step: string; message: string; metadata?: Record<string, unknown> }>;
}

type ProviderByType = Partial<Record<"MEDIA" | "VOICE" | "MUSIC", ProviderCredential[]>>;

interface OpenverseAudioCandidate {
  url: string;
  title: string | null;
  creator: string | null;
  provider: string | null;
  source: string | null;
  license: string;
  licenseUrl: string | null;
  duration: number | null;
  filetype: string | null;
  filesize?: number;
  foreignLandingUrl: string | null;
}

export async function collectSceneAssets(
  scene: Scene,
  providers: ProviderByType,
  prompts?: { backgroundVideoPrompt?: string | null; musicPrompt?: string | null }
): Promise<SceneAssets> {
  const log: SceneAssets["log"] = [];
  const mediaUrl = await findMedia(scene, providers.MEDIA ?? [], log, prompts?.backgroundVideoPrompt);
  const voiceUrl = await createVoice(scene, providers.VOICE ?? [], log);
  const musicUrl = await findMusic(scene, providers.MUSIC ?? [], log, prompts?.musicPrompt);

  return { mediaUrl, voiceUrl, musicUrl, log };
}

async function findMedia(scene: Scene, providers: ProviderCredential[], log: SceneAssets["log"], backgroundVideoPrompt?: string | null) {
  const query = buildPexelsQuery(scene, backgroundVideoPrompt);
  for (const provider of providers) {
    log.push({
      step: "media_provider_attempt",
      message: "מחפש מדיה לסצנה לפי שאילתה ממוקדת",
      metadata: { provider: provider.provider, sceneId: scene.id, query }
    });

    if (provider.provider.toLowerCase().includes("pexels") && provider.encryptedKey) {
      const apiKey = safeDecryptProviderKey(provider.encryptedKey, provider.provider, log);
      if (!apiKey) {
        continue;
      }

      if (!query) {
        log.push({ step: "media_query_missing", message: "לא נמצאה שאילתת מדיה מספיק ממוקדת לסצנה", metadata: { sceneId: scene.id } });
        continue;
      }

      const result = await searchPexels(query, apiKey, scene.durationSeconds, log);
      if (result) {
        log.push({
          step: "media_provider_success",
          message: "נמצאה מדיה מתאימה לפי אורך ומשקל",
          metadata: {
            provider: provider.provider,
            query,
            url: result.link,
            duration: result.duration,
            width: result.width,
            height: result.height,
            fileSize: result.fileSize
          }
        });
        return result.link;
      }
    }

    log.push({ step: "media_provider_skipped", message: "ספק מדיה לא נתמך או ללא מפתח", metadata: { provider: provider.provider } });
  }

  log.push({ step: "media_fallback", message: "לא נמצאה מדיה חיצונית, משתמש ברקע גרפי" });
  return undefined;
}

function buildPexelsQuery(scene: Scene, backgroundVideoPrompt?: string | null) {
  const source = backgroundVideoPrompt || scene.visualPrompt || `${scene.title} ${scene.narration}`;
  const cleaned = source
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
    .filter((word) => word.length > 2)
    .filter((word) => !mediaStopWords.has(word));

  const englishWords = cleaned.filter((word) => /^[a-z0-9-]+$/.test(word));
  const selected = (englishWords.length >= 2 ? englishWords : cleaned).slice(0, 12);
  return selected.join(" ");
}

const mediaStopWords = new Set([
  "scene",
  "video",
  "shot",
  "visual",
  "prompt",
  "advertising",
  "advertisement",
  "promotional",
  "product",
  "opening",
  "action",
  "call",
  "cta",
  "website",
  "introducing",
  "tired",
  "same",
  "old",
  "ready",
  "elevate",
  "style",
  "timepiece",
  "redefines",
  "with",
  "the",
  "and",
  "for",
  "this",
  "that",
  "you",
  "your",
  "text",
  "screen",
  "background"
]);

function safeDecryptProviderKey(encryptedKey: string, provider: string, log: SceneAssets["log"]) {
  try {
    return decryptSecret(encryptedKey);
  } catch (error) {
    log.push({
      step: "provider_key_decrypt_failed",
      message: "פענוח מפתח הספק נכשל; מדלג לספק הבא או לרקע גרפי",
      metadata: {
        provider,
        reason: error instanceof Error ? error.message : "unknown decrypt error",
        hint: "ודא שה־ENCRYPTION_KEY זהה בשירות web ובשירות worker ב־Render"
      }
    });
    return undefined;
  }
}

async function createVoice(scene: Scene, providers: ProviderCredential[], log: SceneAssets["log"]) {
  for (const provider of providers) {
    log.push({ step: "voice_provider_attempt", message: "מנסה ליצור קריינות לסצנה", metadata: { provider: provider.provider, sceneId: scene.id } });
    if (provider.provider.toLowerCase().includes("openverse")) {
      const audio = await searchOpenverseAudio({
        provider,
        query: buildAudioQuery(scene),
        targetDuration: scene.durationSeconds,
        log,
        logPrefix: "voice"
      });
      if (audio) {
        log.push({
          step: "voice_provider_success",
          message: "נמצא קובץ קול ב-Openverse לסצנה",
          metadata: audio.metadata
        });
        return audio.url;
      }
      continue;
    }

    log.push({ step: "voice_provider_deferred", message: "חיבור TTS מלא יופעל בשלב הבא; הקליפ יכלול כרגע כתוביות", metadata: { provider: provider.provider } });
  }
  return undefined;
}

async function findMusic(scene: Scene, providers: ProviderCredential[], log: SceneAssets["log"], musicPrompt?: string | null) {
  for (const provider of providers) {
    log.push({ step: "music_provider_attempt", message: "מנסה לאתר מוסיקת רקע לסצנה", metadata: { provider: provider.provider, sceneId: scene.id, musicPrompt } });
    if (provider.provider.toLowerCase().includes("openverse")) {
      const audio = await searchOpenverseAudio({
        provider,
        query: buildAudioQuery(scene, musicPrompt),
        targetDuration: scene.durationSeconds,
        log,
        logPrefix: "music"
      });
      if (audio) {
        log.push({
          step: "music_provider_success",
          message: "נמצא קובץ מוסיקה/אודיו ב-Openverse לסצנה",
          metadata: audio.metadata
        });
        return audio.url;
      }
      continue;
    }

    log.push({ step: "music_provider_deferred", message: "חיבור מוסיקה חיצונית יופעל בשלב הבא; הקליפ יורנדר ללא מוסיקה", metadata: { provider: provider.provider } });
  }
  return undefined;
}

function buildAudioQuery(scene: Scene, prompt?: string | null) {
  const source = prompt || scene.visualPrompt || `${scene.title} ${scene.narration}`;
  const cleaned = source
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
    .filter((word) => word.length > 2)
    .filter((word) => !audioStopWords.has(word));

  const englishWords = cleaned.filter((word) => /^[a-z0-9-]+$/.test(word));
  const selected = (englishWords.length >= 2 ? englishWords : cleaned).slice(0, 10);
  return selected.join(" ") || "upbeat background music";
}

const audioStopWords = new Set([
  ...mediaStopWords,
  "music",
  "audio",
  "sound",
  "voice",
  "narration",
  "background",
  "clip"
]);

async function searchOpenverseAudio(input: {
  provider: ProviderCredential;
  query: string;
  targetDuration: number;
  log: SceneAssets["log"];
  logPrefix: "voice" | "music";
}) {
  const credentials = openverseCredentials(input.provider, input.log);
  const config = asRecord(input.provider.config);
  const baseUrl = stringConfig(config.baseUrl);
  const pageSize = numberConfig(config.pageSize) ?? 10;
  const timeoutMs = numberConfig(config.timeoutMs) ?? 8000;
  const client = OpenverseClient({
    ...(baseUrl ? { baseUrl } : {}),
    ...(credentials ? { credentials } : {})
  });

  input.log.push({
    step: `${input.logPrefix}_openverse_search_started`,
    message: "מחפש קובץ אודיו ב-Openverse",
    metadata: {
      provider: input.provider.provider,
      query: input.query,
      authenticated: Boolean(credentials),
      pageSize
    }
  });

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Openverse search timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const response = await Promise.race([
      client("GET v1/audio/", {
        params: {
          q: input.query,
          page_size: pageSize,
          mature: false
        } as never
      }),
      timeout
    ]);

    if (response.meta.status >= 400) {
      input.log.push({
        step: `${input.logPrefix}_openverse_error`,
        message: "Openverse החזיר שגיאה בחיפוש אודיו",
        metadata: { status: response.meta.status, query: input.query }
      });
      return undefined;
    }

    const candidates = response.body.results
      .filter((audio) => Boolean(audio.url) && !audio.mature)
      .map((audio: OpenverseAudioDetail): OpenverseAudioCandidate => ({
        url: audio.url!,
        title: audio.title,
        creator: audio.creator,
        provider: audio.provider,
        source: audio.source,
        license: audio.license,
        licenseUrl: audio.license_url,
        duration: audio.duration,
        filetype: audio.filetype,
        filesize: parseFileSize(audio.filesize),
        foreignLandingUrl: audio.foreign_landing_url
      }))
      .sort((a: OpenverseAudioCandidate, b: OpenverseAudioCandidate) => {
        const durationDiff = Math.abs((a.duration ?? input.targetDuration) - input.targetDuration) - Math.abs((b.duration ?? input.targetDuration) - input.targetDuration);
        if (durationDiff !== 0) {
          return durationDiff;
        }
        return (a.filesize ?? Number.MAX_SAFE_INTEGER) - (b.filesize ?? Number.MAX_SAFE_INTEGER);
      });

    const selected = candidates[0];
    if (!selected) {
      input.log.push({
        step: `${input.logPrefix}_openverse_no_match`,
        message: "Openverse לא החזיר קובץ אודיו מתאים",
        metadata: { query: input.query, returnedResults: response.body.results.length }
      });
      return undefined;
    }

    return {
      url: selected.url,
      metadata: {
        provider: input.provider.provider,
        query: input.query,
        title: selected.title,
        creator: selected.creator,
        source: selected.source ?? selected.provider,
        license: selected.license,
        licenseUrl: selected.licenseUrl,
        duration: selected.duration,
        filetype: selected.filetype,
        filesize: selected.filesize,
        foreignLandingUrl: selected.foreignLandingUrl,
        url: selected.url
      }
    };
  } catch (error) {
    input.log.push({
      step: `${input.logPrefix}_openverse_error`,
      message: "חיפוש Openverse נכשל או עבר timeout",
      metadata: {
        query: input.query,
        error: error instanceof Error ? error.message : "unknown openverse error"
      }
    });
    return undefined;
  }
}

function openverseCredentials(provider: ProviderCredential, log: SceneAssets["log"]) {
  const config = asRecord(provider.config);
  const configClientId = stringConfig(config.clientId);
  const configClientSecret = stringConfig(config.clientSecret);
  if (configClientId && configClientSecret) {
    return { clientId: configClientId, clientSecret: configClientSecret };
  }

  if (!provider.encryptedKey) {
    return undefined;
  }

  const secret = safeDecryptProviderKey(provider.encryptedKey, provider.provider, log);
  if (!secret) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(secret) as { clientId?: string; clientSecret?: string };
    if (parsed.clientId && parsed.clientSecret) {
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    }
  } catch {
    const [clientId, clientSecret] = secret.split(":");
    if (clientId && clientSecret) {
      return { clientId, clientSecret };
    }
  }

  log.push({
    step: "openverse_credentials_ignored",
    message: "מפתח Openverse נשמר אך לא זוהה כ-clientId:clientSecret או JSON; ממשיך בחיפוש אנונימי",
    metadata: { provider: provider.provider }
  });
  return undefined;
}

async function searchPexels(query: string, apiKey: string, sceneDuration: number, log: SceneAssets["log"]) {
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "portrait");
  url.searchParams.set("per_page", "10");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: apiKey
      }
    });

    if (!response.ok) {
      log.push({ step: "media_provider_error", message: "Pexels החזיר שגיאה", metadata: { status: response.status, query } });
      return undefined;
    }

    const payload = (await response.json()) as PexelsSearchResponse;
    const videos = payload.videos ?? [];
    const idealMaxDuration = Math.min(8, Math.max(7, sceneDuration));
    const candidates = buildPexelsCandidates(videos, 7, idealMaxDuration);
    const fallbackCandidates = candidates.length > 0 ? candidates : buildPexelsCandidates(videos, 1, 30);

    if (fallbackCandidates.length === 0) {
      log.push({
        step: "media_provider_no_match",
        message: "Pexels לא החזיר סרטון באורך 7-8 שניות וגם לא עד 30 שניות",
        metadata: { query, idealMaxDuration, fallbackMaxDuration: 30, returnedVideos: videos.length }
      });
      return undefined;
    }

    if (candidates.length === 0) {
      log.push({
        step: "media_provider_fallback_duration",
        message: "לא נמצא וידאו 7-8 שניות; בוחר וידאו עד 30 שניות",
        metadata: { query, returnedVideos: videos.length }
      });
    }

    return fallbackCandidates[0];
  } catch (error) {
    log.push({
      step: "media_provider_error",
      message: "קריאת Pexels נכשלה או עברה timeout",
      metadata: { query, error: error instanceof Error ? error.message : "unknown error" }
    });
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPexelsCandidates(videos: NonNullable<PexelsSearchResponse["videos"]>, minDuration: number, maxDuration: number) {
  return videos
      .filter((video) => video.duration >= minDuration && video.duration <= maxDuration)
      .flatMap((video) => {
        return (video.video_files ?? [])
          .filter((file) => file.link)
          .map((file) => ({
            link: file.link,
            duration: video.duration,
            width: file.width ?? 0,
            height: file.height ?? 0,
            fileSize: file.file_size ?? Number.MAX_SAFE_INTEGER
          }));
      })
      .sort((a, b) => {
        const durationDiff = Math.abs(a.duration - 8) - Math.abs(b.duration - 8);
        if (durationDiff !== 0) {
          return durationDiff;
        }
        return (a.fileSize ?? Number.MAX_SAFE_INTEGER) - (b.fileSize ?? Number.MAX_SAFE_INTEGER);
      });
}

interface PexelsSearchResponse {
  videos?: Array<{
    duration: number;
    video_files?: Array<{
      link?: string;
      width?: number;
      height?: number;
      file_size?: number;
    }>;
  }>;
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

function parseFileSize(value: string | null) {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
