import type { ProviderCredential, Scene } from "@prisma/client";
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

interface OpenverseAudioDetail {
  url?: string | null;
  title: string | null;
  creator: string | null;
  provider: string | null;
  source: string | null;
  license: string;
  license_url: string | null;
  duration: number | null;
  filetype: string | null;
  filesize: string | null;
  foreign_landing_url: string | null;
  mature?: boolean;
}

interface OpenverseAudioResponse {
  results: OpenverseAudioDetail[];
}

export async function collectSceneAssets(
  scene: Scene,
  providers: ProviderByType,
  prompts?: { backgroundVideoPrompt?: string | null; sceneMediaPrompt?: string | null; musicPrompt?: string | null }
): Promise<SceneAssets> {
  const log: SceneAssets["log"] = [];
  const mediaUrl = await findMedia(scene, providers.MEDIA ?? [], log, prompts?.sceneMediaPrompt ?? prompts?.backgroundVideoPrompt);
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
  const source = scene.visualPrompt || backgroundVideoPrompt || `${scene.title} ${scene.narration}`;
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
      log.push({
        step: "voice_provider_skipped",
        message: "Openverse הוא מאגר אודיו/מוסיקה ולא מנוע TTS לדיבוב דיאלוג; מדלג כדי לא לצרף קול לא קשור",
        metadata: { provider: provider.provider, sceneId: scene.id }
      });
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
      const queries = buildAudioQueryVariants(scene, musicPrompt);
      for (let qi = 0; qi < queries.length; qi++) {
        const query = queries[qi];
        const audio = await searchOpenverseAudio({
          provider,
          query,
          targetDuration: scene.durationSeconds,
          log,
          logPrefix: "music"
        });
        if (audio) {
          log.push({
            step: "music_provider_success",
            message: "נמצא קובץ מוסיקה/אודיו ב-Openverse לסצנה",
            metadata: { ...audio.metadata, queriesTried: qi + 1 }
          });
          return audio.url;
        }
      }
      continue;
    }

    log.push({ step: "music_provider_deferred", message: "חיבור מוסיקה חיצונית יופעל בשלב הבא; הקליפ יורנדר ללא מוסיקה", metadata: { provider: provider.provider } });
  }
  return undefined;
}

function buildAudioQuery(scene: Scene, prompt?: string | null) {
  const quoted =
    prompt?.match(/"([^"]{3,120})"/)?.[1]?.trim() ??
    prompt?.match(/'([^']{3,120})'/)?.[1]?.trim();
  const source = quoted || prompt || scene.visualPrompt || `${scene.title} ${scene.narration}`;
  const cleaned = source
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
    .filter((word) => word.length > 2)
    .filter((word) => !audioStopWords.has(word));

  const englishWords = cleaned.filter((word) => /^[a-z0-9-]+$/.test(word));
  const selected = (englishWords.length >= 2 ? englishWords : cleaned).slice(0, 10);
  return selected.join(" ") || "instrumental background music";
}

const OPENVERSE_MUSIC_FALLBACK_QUERIES = [
  "instrumental cinematic ambient",
  "soft piano instrumental background",
  "corporate upbeat instrumental",
  "calm acoustic instrumental",
  "luxury lounge ambient instrumental"
];

function buildAudioQueryVariants(scene: Scene, prompt?: string | null): string[] {
  const primary = buildAudioQuery(scene, prompt);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const q = raw.trim().replace(/\s+/g, " ");
    if (q.length < 2 || seen.has(q)) {
      return;
    }
    seen.add(q);
    out.push(q);
  };
  push(primary);
  for (const fb of OPENVERSE_MUSIC_FALLBACK_QUERIES) {
    push(fb);
  }
  return out;
}

const openverseAccessTokenCache = new Map<string, { token: string; expiresAtMs: number }>();

async function fetchOpenverseAccessToken(
  baseUrl: string,
  credentials: { clientId: string; clientSecret: string },
  timeoutMs: number,
  log: SceneAssets["log"]
): Promise<string | undefined> {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  const cacheKey = `${normalizedBase}:${credentials.clientId}`;
  const now = Date.now();
  const cached = openverseAccessTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now + 15_000) {
    return cached.token;
  }

  const tokenUrl = new URL("/v1/auth_tokens/token/", normalizedBase);
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret
    });
    const response = await fetchWithTimeout(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "AdBot/0.1 (+https://promovid.onrender.com)"
        },
        body
      },
      timeoutMs
    );

    if (!response.ok) {
      log.push({
        step: "openverse_token_error",
        message: "קבלת טוקן Openverse נכשלה — ממשיכים בחיפוש ללא אימות",
        metadata: { status: response.status }
      });
      return undefined;
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    const token = typeof payload.access_token === "string" ? payload.access_token : undefined;
    if (!token) {
      log.push({
        step: "openverse_token_error",
        message: "תשובת Openverse ללא access_token — ממשיכים בלי Bearer",
        metadata: {}
      });
      return undefined;
    }

    const ttlSec = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
    openverseAccessTokenCache.set(cacheKey, { token, expiresAtMs: now + Math.max(60_000, ttlSec * 1000) });
    return token;
  } catch (error) {
    log.push({
      step: "openverse_token_error",
      message: "קריאת טוקן Openverse נכשלה — ממשיכים בלי Bearer",
      metadata: { error: error instanceof Error ? error.message : "unknown" }
    });
    return undefined;
  }
}

async function searchOpenverseAudio(input: {
  provider: ProviderCredential;
  query: string;
  targetDuration: number;
  log: SceneAssets["log"];
  logPrefix: "voice" | "music";
}) {
  const config = asRecord(input.provider.config);
  const baseUrl = stringConfig(config.baseUrl) ?? "https://api.openverse.org";
  const pageSize = numberConfig(config.pageSize) ?? 10;
  const timeoutMs = numberConfig(config.timeoutMs) ?? 8000;
  const credentials = openverseCredentials(input.provider, input.log);
  const bearerToken = credentials ? await fetchOpenverseAccessToken(baseUrl, credentials, timeoutMs, input.log) : undefined;

  input.log.push({
    step: `${input.logPrefix}_openverse_search_started`,
    message: "מחפש קובץ אודיו ב-Openverse",
    metadata: {
      provider: input.provider.provider,
      query: input.query,
      credentialsConfigured: Boolean(credentials),
      bearerAttached: Boolean(bearerToken),
      pageSize
    }
  });

  try {
    const url = new URL("/v1/audio/", baseUrl);
    url.searchParams.set("q", input.query);
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("mature", "false");

    const response = await fetchWithTimeout(url, {
      headers: {
        "user-agent": "AdBot/0.1 (+https://promovid.onrender.com)",
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
      }
    }, timeoutMs);

    if (!response.ok) {
      input.log.push({
        step: `${input.logPrefix}_openverse_error`,
        message: "Openverse החזיר שגיאה בחיפוש אודיו",
        metadata: { status: response.status, query: input.query }
      });
      return undefined;
    }

    const payload = await response.json() as OpenverseAudioResponse;
    const candidates = (payload.results ?? [])
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
        metadata: { query: input.query, returnedResults: payload.results?.length ?? 0 }
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

async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number) {
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
