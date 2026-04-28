import type { SceneInput } from "@promovid/shared";

interface ScriptRequest {
  title: string;
  sourceText: string;
  duration: number;
  style?: string;
  targetAudience?: string;
  aspectRatio?: string;
  provider?: ScriptProviderSettings | null;
  onLog?: OperationLogger;
}

interface ScriptProviderSettings {
  provider: string;
  apiKey?: string;
  config?: unknown;
}

interface SourceContext {
  rawInput: string;
  url?: string;
  instructions: string;
  pageText?: string;
  fetchError?: string;
}

type OperationLogger = (...args: [string, string, Record<string, unknown>?]) => void;

export async function generateScript(request: ScriptRequest): Promise<SceneInput[]> {
  const sourceContext = await buildSourceContext(request.sourceText, request.onLog);
  if (request.provider) {
    if (!request.provider.apiKey) {
      throw new Error(`Script provider ${request.provider.provider} is enabled but has no API key.`);
    }

    if (request.provider.provider.toLowerCase().includes("gemini")) {
      return generateGeminiScript(request, request.provider, sourceContext);
    }

    throw new Error(`Script provider ${request.provider.provider} is not implemented yet.`);
  }

  const sceneCount = Math.max(2, Math.ceil(request.duration / 8));
  const cleanSource = sourceContext.pageText || sourceContext.instructions || sourceContext.rawInput;
  const style = request.style || "modern, clear, conversion-oriented";
  const audience = request.targetAudience || "general audience";

  return Array.from({ length: sceneCount }, (_, index) => ({
    title: `Scene ${index + 1}`,
    narration: buildNarration(cleanSource, index, sceneCount, style, audience),
    visualPrompt: `Vertical promotional shot for "${cleanSource}", ${style}, scene ${index + 1}`,
    durationSeconds: Math.round(request.duration / sceneCount)
  }));
}

function buildNarration(source: string, index: number, total: number, style: string, audience: string) {
  if (index === 0) {
    return `Meet ${source}. A fast way to catch attention for ${audience}.`;
  }

  if (index === total - 1) {
    return `Bring ${source} to your audience today with a focused ${style} message.`;
  }

  return `${source} helps turn interest into action with a concise benefit-driven story.`;
}

async function generateGeminiScript(
  request: ScriptRequest,
  provider: ScriptProviderSettings,
  sourceContext: SourceContext
): Promise<SceneInput[]> {
  const model = readConfigValue(provider.config, "model") ?? "gemini-2.0-flash";
  const prompt = buildGeminiPrompt(request, sourceContext);
  request.onLog?.("gemini_prompt_ready", "נבנה prompt מפורט עבור Gemini", {
    model,
    promptLength: prompt.length,
    hasUrl: Boolean(sourceContext.url),
    hasPageText: Boolean(sourceContext.pageText)
  });
  request.onLog?.("gemini_request_start", "שולח בקשה ל-Gemini ליצירת תסריט", { model });
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(provider.apiKey ?? "")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: Number(readConfigValue(provider.config, "temperature") ?? 0.7),
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const readableError = formatGeminiError(errorText, response.status, model);
    request.onLog?.("gemini_request_failed", "Gemini החזיר שגיאה", {
      status: response.status,
      error: readableError
    });
    throw new Error(readableError);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  request.onLog?.("gemini_response_received", "התקבלה תשובה מ-Gemini", { responseLength: text.length });
  const scenes = normalizeScenes(parseSceneResponse(text), request.duration);
  request.onLog?.("gemini_response_parsed", "תשובת Gemini פוענחה לסצנות", { sceneCount: scenes.length });
  return scenes;
}

function buildGeminiPrompt(request: ScriptRequest, sourceContext: SourceContext) {
  const sceneCount = Math.max(2, Math.ceil(request.duration / 8));
  return `
אתה מחולל תסריטי פרסומת מקצועי לווידאו קצר.

המשימה:
כתוב תסריט פרסומת מלא, מפורט, מקורי ומשכנע על בסיס פריט המידע של המשתמש.
אסור להעתיק את הטקסט כפי שהוא. חובה לעבד אותו לתסריט שיווקי עם מבנה, מסר, פתיחה, ערך, הוכחה/תועלת וקריאה לפעולה.

הגדרות הסרטון:
- כותרת: ${request.title}
- אורך כולל: ${request.duration} שניות
- מספר סצנות רצוי: ${sceneCount}
- כל סצנה חייבת להיות באורך 7-8 שניות, למעט התאמה קטנה כדי להגיע לאורך הכולל.
- יחס תצוגה: ${request.aspectRatio ?? "9:16"}
- סגנון: ${request.style || "חד, מודרני, מכירתי"}
- קהל יעד: ${request.targetAudience || "לקוחות חדשים"}

מקור המידע:
${sourceContext.url ? `- URL: ${sourceContext.url}` : "- URL: לא סופק"}

הוראות המשתמש לבניית התסריט והסרטון:
${sourceContext.instructions || "לא סופקו הוראות נוספות מעבר לפריט המידע."}

תוכן שחולץ מעמוד האינטרנט:
${sourceContext.pageText || sourceContext.fetchError || "לא סופק או לא ניתן היה לחלץ תוכן מהעמוד."}

קלט גולמי מלא:
${sourceContext.rawInput}

אם תוכן העמוד חסום, דל, או מכיל הודעת בדיקת דפדפן, השתמש בהוראות המשתמש וב־URL כהקשר, אבל אל תמציא פרטים ספציפיים שלא הופיעו במקור.

החזר JSON בלבד, בלי Markdown ובלי הסברים, במבנה הבא:
{
  "scenes": [
    {
      "title": "שם קצר לסצנה",
      "narration": "טקסט קריינות מלא ומוכן להקראה עבור הסצנה",
      "visualPrompt": "תיאור ויזואלי מפורט ליצירת מדיה/וידאו עבור הסצנה",
      "durationSeconds": 8
    }
  ]
}

דרישות איכות:
- narration חייב להיות טבעי, שיווקי וברור.
- visualPrompt חייב לתאר צילום/אווירה/אובייקטים/טקסט על המסך.
- אין להשתמש במשפטים כלליים כמו "Meet..." אם אינם מתאימים לשפה ולמוצר.
- אם הקלט בעברית, כתוב את הקריינות בעברית.
`.trim();
}

async function buildSourceContext(rawInput: string, onLog?: OperationLogger): Promise<SourceContext> {
  const url = extractFirstUrl(rawInput);
  const instructions = url ? rawInput.replace(url, "").trim() : rawInput.trim();
  onLog?.("source_input_received", "התקבל פריט מידע מהמסך", {
    inputLength: rawInput.length,
    hasUrl: Boolean(url),
    instructionsLength: instructions.length
  });

  if (!url) {
    return { rawInput, instructions };
  }

  try {
    onLog?.("source_url_fetch_start", "מתחיל לקרוא תוכן מעמוד URL", { url });
    const pageText = await fetchPageText(url);
    onLog?.("source_url_fetch_success", "תוכן העמוד נקרא בהצלחה", {
      url,
      extractedCharacters: pageText.length
    });
    return { rawInput, url, instructions, pageText };
  } catch (error) {
    onLog?.("source_url_fetch_failed", "קריאת תוכן העמוד נכשלה, ממשיך עם URL והוראות", {
      url,
      error: error instanceof Error ? error.message : "unknown error"
    });
    return {
      rawInput,
      url,
      instructions,
      fetchError: `לא ניתן היה לקרוא את תוכן העמוד: ${error instanceof Error ? error.message : "unknown error"}`
    };
  }
}

function extractFirstUrl(value: string) {
  const match = value.match(/https?:\/\/[^\s<>"']+/i);
  return match?.[0]?.replace(/[),.]+$/g, "");
}

async function fetchPageText(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; AdBot/0.1; +https://promovid.onrender.com)"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new Error(`unsupported content-type ${contentType || "unknown"}`);
    }

    return htmlToText(await response.text()).slice(0, 12000);
  } finally {
    clearTimeout(timeout);
  }
}

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSceneResponse(text: string): SceneInput[] {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as { scenes?: SceneInput[] } | SceneInput[];
  return Array.isArray(parsed) ? parsed : parsed.scenes ?? [];
}

function normalizeScenes(scenes: SceneInput[], totalDuration: number) {
  if (scenes.length === 0) {
    throw new Error("Gemini returned no script scenes.");
  }

  const durations = distributeDurations(totalDuration, scenes.length);
  return scenes.map((scene, index) => ({
    title: scene.title || `Scene ${index + 1}`,
    narration: scene.narration,
    visualPrompt: scene.visualPrompt,
    durationSeconds: durations[index] ?? clampDuration(Number(scene.durationSeconds) || 8)
  }));
}

function clampDuration(duration: number) {
  return Math.min(8, Math.max(7, Math.round(duration)));
}

function distributeDurations(totalDuration: number, sceneCount: number) {
  const base = Math.floor(totalDuration / sceneCount);
  let remainder = totalDuration - base * sceneCount;
  return Array.from({ length: sceneCount }, () => {
    const duration = clampDuration(base + (remainder > 0 ? 1 : 0));
    remainder -= 1;
    return duration;
  });
}

function readConfigValue(config: unknown, key: string) {
  if (config && typeof config === "object" && key in config) {
    const value = (config as Record<string, unknown>)[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return undefined;
}

function formatGeminiError(errorText: string, status: number, model: string) {
  try {
    const parsed = JSON.parse(errorText) as {
      error?: {
        status?: string;
        message?: string;
        details?: Array<{ "@type"?: string; retryDelay?: string }>;
      };
    };
    const retryDelay = parsed.error?.details?.find((detail) => "retryDelay" in detail)?.retryDelay;

    if (status === 429 || parsed.error?.status === "RESOURCE_EXHAUSTED") {
      return [
        `Gemini quota exhausted for model ${model}.`,
        "בדוק שה־API key מחובר לפרויקט עם quota/billing פעיל, או שנה model במסך הגדרות > תסריט.",
        retryDelay ? `Retry suggested by Google: ${retryDelay}.` : undefined
      ].filter(Boolean).join(" ");
    }

    return `Gemini request failed (${parsed.error?.status ?? status}): ${parsed.error?.message ?? errorText}`;
  } catch {
    return `Gemini request failed (${status}): ${errorText.slice(0, 800)}`;
  }
}
