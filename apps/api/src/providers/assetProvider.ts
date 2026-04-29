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

      const result = await searchPexels(query, apiKey);
      if (result) {
        log.push({ step: "media_provider_success", message: "נמצאה מדיה מתאימה", metadata: { provider: provider.provider, query, url: result } });
        return result;
      }
    }

    log.push({ step: "media_provider_skipped", message: "ספק מדיה לא נתמך או ללא מפתח", metadata: { provider: provider.provider } });
  }

  log.push({ step: "media_fallback", message: "לא נמצאה מדיה חיצונית, משתמש ברקע גרפי" });
  return undefined;
}

function buildPexelsQuery(scene: Scene) {
  const source = `${scene.title} ${scene.visualPrompt} ${scene.narration}`;
  const cleaned = source
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
    .filter((word) => word.length > 2)
    .filter((word) => !mediaStopWords.has(word));

  const englishWords = cleaned.filter((word) => /^[a-z0-9-]+$/.test(word));
  const selected = (englishWords.length >= 2 ? englishWords : cleaned).slice(0, 6);
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
  "with",
  "the",
  "and",
  "for",
  "this",
  "that",
  "you",
  "your",
  "ready",
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

async function searchPexels(query: string, apiKey: string) {
  const url = new URL("https://api.pexels.com/videos/search");
  url.searchParams.set("query", query);
  url.searchParams.set("orientation", "portrait");
  url.searchParams.set("per_page", "1");

  const response = await fetch(url, {
    headers: {
      Authorization: apiKey
    }
  });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as {
    videos?: Array<{ video_files?: Array<{ link?: string; quality?: string; width?: number }> }>;
  };
  const files = payload.videos?.[0]?.video_files ?? [];
  return files
    .filter((file) => file.link)
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.link;
}
