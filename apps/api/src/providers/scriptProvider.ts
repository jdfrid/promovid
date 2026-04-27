import type { SceneInput } from "@promovid/shared";

interface ScriptRequest {
  title: string;
  sourceText: string;
  duration: number;
  style?: string;
  targetAudience?: string;
  aspectRatio?: string;
  provider?: ScriptProviderSettings | null;
}

interface ScriptProviderSettings {
  provider: string;
  apiKey?: string;
  config?: unknown;
}

export async function generateScript(request: ScriptRequest): Promise<SceneInput[]> {
  if (request.provider) {
    if (!request.provider.apiKey) {
      throw new Error(`Script provider ${request.provider.provider} is enabled but has no API key.`);
    }

    if (request.provider.provider.toLowerCase().includes("gemini")) {
      return generateGeminiScript(request, request.provider);
    }

    throw new Error(`Script provider ${request.provider.provider} is not implemented yet.`);
  }

  const sceneCount = Math.max(2, Math.ceil(request.duration / 8));
  const cleanSource = request.sourceText.trim();
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

async function generateGeminiScript(request: ScriptRequest, provider: ScriptProviderSettings): Promise<SceneInput[]> {
  const model = readConfigValue(provider.config, "model") ?? "gemini-2.0-flash";
  const prompt = buildGeminiPrompt(request);
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
    throw new Error(`Gemini script generation failed: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  return normalizeScenes(parseSceneResponse(text), request.duration);
}

function buildGeminiPrompt(request: ScriptRequest) {
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

פריט מידע גולמי:
${request.sourceText}

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
