import type { ProviderCredential, Scene } from "@prisma/client";
import { decryptSecret } from "../crypto.js";

export interface SceneAssets {
  mediaUrl?: string;
  voiceUrl?: string;
  musicUrl?: string;
  log: Array<{ step: string; message: string; metadata?: Record<string, unknown> }>;
}

type ProviderByType = Partial<Record<"MEDIA" | "VOICE" | "MUSIC", ProviderCredential[]>>;

export async function collectSceneAssets(scene: Scene, providers: ProviderByType): Promise<SceneAssets> {
  const log: SceneAssets["log"] = [];
  const mediaUrl = await findMedia(scene, providers.MEDIA ?? [], log);
  const voiceUrl = await createVoice(scene, providers.VOICE ?? [], log);
  const musicUrl = await findMusic(scene, providers.MUSIC ?? [], log);

  return { mediaUrl, voiceUrl, musicUrl, log };
}

async function findMedia(scene: Scene, providers: ProviderCredential[], log: SceneAssets["log"]) {
  const query = buildPexelsQuery(scene);
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

function buildPexelsQuery(scene: Scene) {
  const source = scene.visualPrompt || `${scene.title} ${scene.narration}`;
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
    log.push({ step: "voice_provider_deferred", message: "חיבור TTS מלא יופעל בשלב הבא; הקליפ יכלול כרגע כתוביות", metadata: { provider: provider.provider } });
  }
  return undefined;
}

async function findMusic(scene: Scene, providers: ProviderCredential[], log: SceneAssets["log"]) {
  for (const provider of providers) {
    log.push({ step: "music_provider_attempt", message: "מנסה לאתר מוסיקת רקע לסצנה", metadata: { provider: provider.provider, sceneId: scene.id } });
    log.push({ step: "music_provider_deferred", message: "חיבור מוסיקה חיצונית יופעל בשלב הבא; הקליפ יורנדר ללא מוסיקה", metadata: { provider: provider.provider } });
  }
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
