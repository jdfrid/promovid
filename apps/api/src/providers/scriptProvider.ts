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

export interface ScriptGenerationResult {
  scenes: SceneInput[];
  backgroundVideoPrompt?: string;
  musicPrompt?: string;
}

export interface ScriptAnalysisResult {
  summary: string;
  visualDirection: string;
  backgroundVideoPrompt: string;
  musicPrompt: string;
  characters: Array<{
    name: string;
    role: string;
    avatarPrompt: string;
    voicePrompt: string;
  }>;
  scenes: Array<{
    order: number;
    title: string;
    visualRequirements: string;
    backgroundPrompt: string;
    avatarPrompt?: string;
    voicePrompt: string;
    musicPrompt: string;
    timeline: Array<{
      startSecond: number;
      endSecond: number;
      action: string;
      dialogue?: string;
      speaker?: string;
      requiredAssets: string[];
    }>;
  }>;
}

export async function generateScript(request: ScriptRequest): Promise<ScriptGenerationResult> {
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

  return {
    backgroundVideoPrompt: `${cleanSource} ${style} lifestyle product background`,
    musicPrompt: `${style} upbeat commercial background music for ${audience}`,
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      title: `Scene ${index + 1}`,
      narration: buildNarration(cleanSource, index, sceneCount, style, audience),
      visualPrompt: `Vertical promotional shot for "${cleanSource}", ${style}, scene ${index + 1}`,
      durationSeconds: Math.round(request.duration / sceneCount)
    }))
  };
}

export async function analyzeScript(request: ScriptRequest & { scenes: SceneInput[] }): Promise<ScriptAnalysisResult> {
  const sourceContext = await buildSourceContext(request.sourceText, request.onLog);
  if (request.provider) {
    if (!request.provider.apiKey) {
      throw new Error(`Script analysis provider ${request.provider.provider} is enabled but has no API key.`);
    }

    if (request.provider.provider.toLowerCase().includes("gemini")) {
      return analyzeWithGemini(request, request.provider, sourceContext);
    }

    throw new Error(`Script analysis provider ${request.provider.provider} is not implemented yet.`);
  }

  return buildFallbackScriptAnalysis(request);
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

async function analyzeWithGemini(
  request: ScriptRequest & { scenes: SceneInput[] },
  provider: ScriptProviderSettings,
  sourceContext: SourceContext
): Promise<ScriptAnalysisResult> {
  const model = normalizeGeminiModel(readConfigValue(provider.config, "analysisModel") ?? readConfigValue(provider.config, "model") ?? "gemini-2.5-flash-lite");
  const prompt = buildGeminiAnalysisPrompt(request, sourceContext);
  request.onLog?.("gemini_analysis_prompt_ready", "נבנה prompt לניתוח חכם של התסריט וחומרי ההפקה", {
    model,
    promptLength: prompt.length,
    sceneCount: request.scenes.length
  });
  request.onLog?.("gemini_analysis_request_start", "שולח בקשה ל-Gemini לניתוח תסריט וחומרים", { model });
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
          temperature: Number(readConfigValue(provider.config, "temperature") ?? 0.45),
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const readableError = formatGeminiError(errorText, response.status, model);
    request.onLog?.("gemini_analysis_request_failed", "Gemini החזיר שגיאה בניתוח התסריט", {
      status: response.status,
      error: readableError
    });
    throw new Error(readableError);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  request.onLog?.("gemini_analysis_response_received", "התקבל ניתוח חכם מ-Gemini", { responseLength: text.length });
  const analysis = normalizeScriptAnalysis(parseAnalysisResponse(text), request);
  request.onLog?.("gemini_analysis_response_parsed", "ניתוח התסריט פוענח לדרישות חומרים ולו״ז", {
    characterCount: analysis.characters.length,
    sceneCount: analysis.scenes.length
  });
  return analysis;
}

async function generateGeminiScript(
  request: ScriptRequest,
  provider: ScriptProviderSettings,
  sourceContext: SourceContext
): Promise<ScriptGenerationResult> {
  const model = normalizeGeminiModel(readConfigValue(provider.config, "model") ?? "gemini-2.5-flash-lite");
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
  const result = normalizeScriptResponse(parseScriptResponse(text), request.duration);
  request.onLog?.("gemini_response_parsed", "תשובת Gemini פוענחה לסצנות ולפרומפטים", {
    sceneCount: result.scenes.length,
    hasBackgroundVideoPrompt: Boolean(result.backgroundVideoPrompt),
    hasMusicPrompt: Boolean(result.musicPrompt)
  });
  return result;
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
  "backgroundVideoPrompt": "English-only concise description of the best overall background video for the full ad, focused on product/category, environment, subject, mood, camera style",
  "musicPrompt": "English-only concise description of the best background music style for the ad, including mood, tempo, genre, energy",
  "scenes": [
    {
      "title": "שם קצר לסצנה",
      "narration": "טקסט קריינות מלא ומוכן להקראה עבור הסצנה",
      "visualPrompt": "English-only concise media search prompt with concrete product/category, setting, mood, and camera subject",
      "durationSeconds": 8
    }
  ]
}

דרישות איכות:
- backgroundVideoPrompt חייב לתאר את סרטון הרקע הכללי המתאים לכל הפרסומת, ולא CTA או טקסט שיווקי.
- musicPrompt חייב לתאר מוסיקת רקע מתאימה לפרסומת, לא טקסט קריינות.
- narration חייב להיות טבעי, שיווקי וברור.
- visualPrompt חייב להיות באנגלית בלבד, ממוקד לחיפוש מדיה ב-Pexels, ולא כללי. דוגמה: "compact kitchen gadget close up modern home cooking".
- אל תכתוב ב-visualPrompt מילים כלליות בלבד כמו promotional video, product shot, scene, background.
- אין להשתמש במשפטים כלליים כמו "Meet..." אם אינם מתאימים לשפה ולמוצר.
- אם הקלט בעברית, כתוב את הקריינות בעברית.
`.trim();
}

function buildGeminiAnalysisPrompt(request: ScriptRequest & { scenes: SceneInput[] }, sourceContext: SourceContext) {
  return `
אתה מנהל Pre-Production חכם לסרטוני פרסומת.

המטרה:
נתח את בקשת המשתמש ואת התסריט, ובנה מפרט הפקה מלא לאיסוף חומרים ולרינדור עתידי.
התוצר שלך ישמש לחיפוש מדיה, אווטרים, קול/דיבוב ומוסיקה, ולאחר מכן לבניית prompt למחולל וידאו.

פרטי הפרויקט:
- כותרת: ${request.title}
- אורך כולל: ${request.duration} שניות
- יחס תצוגה: ${request.aspectRatio ?? "9:16"}
- סגנון: ${request.style || "לא הוגדר"}
- קהל יעד: ${request.targetAudience || "לא הוגדר"}
- URL: ${sourceContext.url || "לא סופק"}

הוראות המשתמש:
${sourceContext.instructions || sourceContext.rawInput}

תוכן שחולץ מהעמוד:
${sourceContext.pageText || sourceContext.fetchError || "לא זמין"}

התסריט:
${JSON.stringify(request.scenes, null, 2)}

החזר JSON בלבד במבנה הבא:
{
  "summary": "Production summary in Hebrew",
  "visualDirection": "English visual direction for the whole ad",
  "backgroundVideoPrompt": "English search prompt for overall background/reference media",
  "musicPrompt": "English search prompt for background music mood, tempo and genre",
  "characters": [
    {
      "name": "Speaker 1",
      "role": "young presenter",
      "avatarPrompt": "English avatar description",
      "voicePrompt": "English voice direction"
    }
  ],
  "scenes": [
    {
      "order": 0,
      "title": "Scene title",
      "visualRequirements": "English concrete visual requirements",
      "backgroundPrompt": "English media search prompt for this scene",
      "avatarPrompt": "English avatar prompt if relevant",
      "voicePrompt": "English voice/TTS direction for this scene",
      "musicPrompt": "English music direction for this scene",
      "timeline": [
        {
          "startSecond": 0,
          "endSecond": 3,
          "action": "What must happen visually",
          "dialogue": "Exact spoken text if any",
          "speaker": "Speaker 1",
          "requiredAssets": ["backgroundVideo", "voice", "music"]
        }
      ]
    }
  ]
}

דרישות:
- לפרק כל סצנה ללו״ז פנימי של רגעים קצרים.
- אם יש דיאלוג, לזהות דוברים ולהפיק voicePrompt נפרד.
- אם אין דיאלוג, להגדיר קריינות/voiceover.
- prompts לחיפוש מדיה/מוסיקה/אווטרים יהיו באנגלית, קונקרטיים, לא כלליים.
- אל תמציא פרטי מוצר שלא קיימים בקלט; במקום זאת תאר את ההפקה סביב המסר הקיים.
`.trim();
}

function parseAnalysisResponse(text: string): Partial<ScriptAnalysisResult> {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned) as Partial<ScriptAnalysisResult>;
}

function normalizeScriptAnalysis(
  parsed: Partial<ScriptAnalysisResult>,
  request: ScriptRequest & { scenes: SceneInput[] }
): ScriptAnalysisResult {
  const fallback = buildFallbackScriptAnalysis(request);
  return {
    summary: parsed.summary || fallback.summary,
    visualDirection: parsed.visualDirection || fallback.visualDirection,
    backgroundVideoPrompt: parsed.backgroundVideoPrompt || fallback.backgroundVideoPrompt,
    musicPrompt: parsed.musicPrompt || fallback.musicPrompt,
    characters: Array.isArray(parsed.characters) && parsed.characters.length ? parsed.characters.map((character, index) => ({
      name: character.name || `Speaker ${index + 1}`,
      role: character.role || "presenter",
      avatarPrompt: character.avatarPrompt || "friendly commercial presenter avatar",
      voicePrompt: character.voicePrompt || "clear energetic commercial voice"
    })) : fallback.characters,
    scenes: request.scenes.map((scene, index) => {
      const parsedScene = parsed.scenes?.find((item) => item.order === index) ?? parsed.scenes?.[index];
      return {
        order: index,
        title: parsedScene?.title || scene.title,
        visualRequirements: parsedScene?.visualRequirements || scene.visualPrompt,
        backgroundPrompt: parsedScene?.backgroundPrompt || scene.visualPrompt,
        avatarPrompt: parsedScene?.avatarPrompt,
        voicePrompt: parsedScene?.voicePrompt || "clear commercial voiceover matching the narration",
        musicPrompt: parsedScene?.musicPrompt || fallback.musicPrompt,
        timeline: normalizeTimeline(parsedScene?.timeline, scene, index)
      };
    })
  };
}

function buildFallbackScriptAnalysis(request: ScriptRequest & { scenes: SceneInput[] }): ScriptAnalysisResult {
  const style = request.style || "modern commercial";
  const audience = request.targetAudience || "general audience";
  return {
    summary: `תיק הפקה בסיסי עבור ${request.title}, מיועד ל-${audience}.`,
    visualDirection: `${style}, clean product-focused commercial, vertical social media video`,
    backgroundVideoPrompt: `${request.title} ${style} product lifestyle background`,
    musicPrompt: `${style} upbeat commercial background music`,
    characters: [
      {
        name: "Narrator",
        role: "commercial narrator",
        avatarPrompt: `${style} friendly presenter avatar for ${audience}`,
        voicePrompt: `clear energetic voiceover for ${audience}`
      }
    ],
    scenes: request.scenes.map((scene, index) => ({
      order: index,
      title: scene.title,
      visualRequirements: scene.visualPrompt,
      backgroundPrompt: scene.visualPrompt,
      avatarPrompt: `${style} presenter avatar reacting to ${scene.title}`,
      voicePrompt: `voiceover says: ${scene.narration}`,
      musicPrompt: `${style} background music under narration`,
      timeline: normalizeTimeline(undefined, scene, index)
    }))
  };
}

function normalizeTimeline(
  timeline: ScriptAnalysisResult["scenes"][number]["timeline"] | undefined,
  scene: SceneInput,
  sceneIndex: number
) {
  if (Array.isArray(timeline) && timeline.length > 0) {
    return timeline.map((item, index) => ({
      startSecond: Number.isFinite(Number(item.startSecond)) ? Number(item.startSecond) : index * 2,
      endSecond: Number.isFinite(Number(item.endSecond)) ? Number(item.endSecond) : Math.min(scene.durationSeconds, index * 2 + 2),
      action: item.action || scene.visualPrompt,
      dialogue: item.dialogue,
      speaker: item.speaker,
      requiredAssets: Array.isArray(item.requiredAssets) && item.requiredAssets.length ? item.requiredAssets : ["backgroundVideo", "voice", "music"]
    }));
  }

  const mid = Math.max(1, Math.floor(scene.durationSeconds / 2));
  return [
    {
      startSecond: sceneIndex === 0 ? 0 : 0,
      endSecond: mid,
      action: scene.visualPrompt,
      dialogue: scene.narration,
      speaker: "Narrator",
      requiredAssets: ["backgroundVideo", "voice", "music"]
    },
    {
      startSecond: mid,
      endSecond: scene.durationSeconds,
      action: `Continue the visual action for ${scene.title} and prepare transition to the next scene`,
      requiredAssets: ["backgroundVideo", "music"]
    }
  ];
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

function parseScriptResponse(text: string): { scenes?: SceneInput[]; backgroundVideoPrompt?: string; musicPrompt?: string } | SceneInput[] {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as { scenes?: SceneInput[] } | SceneInput[];
  return parsed;
}

function normalizeScriptResponse(
  parsed: { scenes?: SceneInput[]; backgroundVideoPrompt?: string; musicPrompt?: string } | SceneInput[],
  totalDuration: number
): ScriptGenerationResult {
  const scenes = Array.isArray(parsed) ? parsed : parsed.scenes ?? [];
  if (scenes.length === 0) {
    throw new Error("Gemini returned no script scenes.");
  }

  const durations = distributeDurations(totalDuration, scenes.length);
  return {
    backgroundVideoPrompt: Array.isArray(parsed) ? undefined : parsed.backgroundVideoPrompt,
    musicPrompt: Array.isArray(parsed) ? undefined : parsed.musicPrompt,
    scenes: scenes.map((scene, index) => ({
      title: scene.title || `Scene ${index + 1}`,
      narration: scene.narration,
      visualPrompt: scene.visualPrompt,
      durationSeconds: durations[index] ?? clampDuration(Number(scene.durationSeconds) || 8)
    }))
  };
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

function normalizeGeminiModel(model: string) {
  if (model === "gemini-1.5-flash") {
    return "gemini-2.5-flash-lite";
  }
  return model;
}
