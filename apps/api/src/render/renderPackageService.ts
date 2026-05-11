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

export interface ShotstackRenderHints {
  segmentSeconds: number;
  resolution: string;
  textToSpeech: boolean;
  apiVersion: string;
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
  /** Markdown בעברית: מה נשלח בפועל למנוע + בריף וחומרים */
  renderEnginePromptBrief: string;
  shotstackHints?: ShotstackRenderHints;
}

export function buildMaterialLibrary(project: ProjectWithScenes, scriptAnalysis: unknown) {
  const scenes = [...project.scenes].sort((a, b) => a.order - b.order);
  return {
    projectId: project.id,
    createdAt: new Date().toISOString(),
    status: "ready",
    scriptAnalysis,
    previewBrief: buildMaterialPreviewBrief(project),
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
        providerStatus: scene.voiceUrl ? "ready" : "optional"
      },
      music: {
        url: scene.musicUrl,
        prompt: project.musicPrompt,
        providerStatus: scene.musicUrl ? "ready" : "optional"
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
      scene.mediaUrl || scene.referenceMediaUrl ? undefined : "background/reference media"
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
  const shotstackHints = await loadShotstackRenderHints(input.tenantId);
  const renderEnginePromptBrief = buildRenderEnginePromptBrief({
    project: input.project,
    timeline,
    scriptAnalysis,
    missingAssets,
    shotstackHints
  });

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
    missingAssets,
    renderEnginePromptBrief,
    shotstackHints
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

const SHOTSTACK_CLIP_SECONDS = 5;

function excerptText(text: string, maxChars: number) {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}\n\n*(הטקסט קוצר לתצוגה)*`;
}

/** טיוטה קצרה אחרי איסוף חומרים — לפני בניית חבילת הרינדור המלאה */
export function buildMaterialPreviewBrief(project: ProjectWithScenes): string {
  const scenes = [...project.scenes].sort((a, b) => a.order - b.order);
  const lines = [
    `# סיכום תסריט וחומרים`,
    "",
    "זהו סיכום לאחר איסוף חומרים. לאחר **בניית חבילת הרינדור** יוצג גם סיכום מלא למנוע הרינדור (כולל התאמה ל־Shotstack).",
    "",
    "## הקשר פרויקט",
    `- **כותרת:** ${project.title}`,
    `- **משך יעד:** ${project.duration} שניות`,
    `- **יחס תצוגה:** ${project.aspectRatio}`,
    project.style ? `- **סגנון:** ${project.style}` : undefined,
    project.targetAudience ? `- **קהל יעד:** ${project.targetAudience}` : undefined,
    "",
    "## מקור הבקשה והנחיות",
    excerptText(project.sourceText || "(ריק)", 2000),
    "",
    project.backgroundVideoPrompt ? `### כיוון וידאו רקע\n${project.backgroundVideoPrompt}\n` : undefined,
    project.musicPrompt ? `### כיוון מוסיקה\n${project.musicPrompt}\n` : undefined,
    "",
    "## תסריט וחומרים לפי סצנה"
  ].filter((line): line is string => Boolean(line));

  for (const scene of scenes) {
    const bg = scene.referenceMediaUrl ?? scene.mediaUrl;
    lines.push(
      "",
      `### סצנה ${scene.order + 1}: ${scene.title}`,
      `- **משך:** ${scene.durationSeconds}s`,
      `- **קריינות:** ${scene.narration}`,
      `- **חיפוש מדיה / ויזואל:** ${scene.visualPrompt}`,
      `- **רקע (URL):** ${bg ?? "*חסר*"}`,
      `- **קול (URL):** ${scene.voiceUrl ?? "*חסר*"}`,
      `- **מוסיקה (URL):** ${scene.musicUrl ?? "*חסר*"}`
    );
  }

  return lines.join("\n");
}

export async function loadShotstackRenderHints(tenantId: string): Promise<ShotstackRenderHints | undefined> {
  const providers = await prisma.providerCredential.findMany({
    where: {
      tenantId,
      enabled: true,
      OR: [
        { type: "VIDEO", provider: { contains: "shotstack", mode: "insensitive" } },
        { type: "MERGE", provider: { contains: "shotstack", mode: "insensitive" } }
      ]
    },
    orderBy: [{ type: "asc" }, { priority: "asc" }]
  });
  const shotstack = providers.find((row) => row.provider.toLowerCase().includes("shotstack"));
  if (!shotstack) {
    return undefined;
  }
  const cfg = asRecord(shotstack.config);
  const resolutionRaw = typeof cfg.resolution === "string" ? cfg.resolution.toLowerCase() : "sd";
  const resolution = resolutionRaw === "hd" || resolutionRaw === "preview" ? resolutionRaw : "sd";
  const textToSpeech = cfg.textToSpeech !== false;
  const apiVersion = typeof cfg.version === "string" ? cfg.version : "v1";
  return {
    segmentSeconds: SHOTSTACK_CLIP_SECONDS,
    resolution,
    textToSpeech,
    apiVersion
  };
}

function buildRenderEnginePromptBrief(input: {
  project: ProjectWithScenes;
  timeline: Record<string, unknown>;
  scriptAnalysis: Record<string, unknown>;
  missingAssets: Array<{ sceneId: string; sceneOrder: number; missing: string[] }>;
  shotstackHints?: ShotstackRenderHints;
}): string {
  const { project, timeline, scriptAnalysis, missingAssets, shotstackHints } = input;
  const scenes = [...project.scenes].sort((a, b) => a.order - b.order);

  const lines = [
    `# מה נשלח למנוע הרינדור — סיכום`,
    "",
    "מסמך זה משקף את **תוכן התסריט**, **חומרי הגלם שנאספו**, ואת **מה שהמערכת מריצה בפועל** במסלול Shotstack (כשמוגדר). קבצי `instructions.md` ו־`manifest` בחבילה כוללים גם JSON מלא לצורכי ייצוא.",
    "",
    "## הקשר פרויקט",
    `- **כותרת:** ${project.title}`,
    `- **משך יעד:** ${project.duration} שניות`,
    `- **יחס תצוגה:** ${project.aspectRatio}`,
    project.style ? `- **סגנון:** ${project.style}` : undefined,
    project.targetAudience ? `- **קהל יעד:** ${project.targetAudience}` : undefined,
    "",
    "## מקור הבקשה (כולל קישורים וקבצים מהפרה־פרודקשן)",
    excerptText(project.sourceText || "(ריק)", 2500),
    "",
    project.backgroundVideoPrompt ? `### כיוון וידאו רקע כללי\n${project.backgroundVideoPrompt}\n` : undefined,
    project.musicPrompt ? `### כיוון מוסיקה כללי\n${project.musicPrompt}\n` : undefined,
    "",
    "## ניתוח תסריט (תקציר)",
    scriptAnalysisSummary(scriptAnalysis),
    "",
    "## תסריט לפי סצנה",
    ...scenes.flatMap((scene) => [
      "",
      `### סצנה ${scene.order + 1}: ${scene.title}`,
      `- משך: ${scene.durationSeconds}s`,
      `- קריינות: ${scene.narration}`,
      `- פרומפט ויזואל / חיפוש מדיה: ${scene.visualPrompt}`
    ]),
    "",
    "## חומרים שנאספו (קישורים)",
    ...scenes.flatMap((scene) => {
      const bg = scene.referenceMediaUrl ?? scene.mediaUrl;
      return [
        "",
        `### סצנה ${scene.order + 1}`,
        `- רקע / רפרנס וידאו: ${bg ?? "*לא נאסף*"}`,
        `- קול / דיאלוג: ${scene.voiceUrl ?? "*לא נאסף*"}`,
        `- מוסיקה: ${scene.musicUrl ?? "*לא נאסף*"}`
      ];
    })
  ].filter((line): line is string => Boolean(line));

  if (missingAssets.length > 0) {
    lines.push("", "## אזהרות — חומרים חסרים");
    for (const group of missingAssets) {
      lines.push(`- סצנה ${group.sceneOrder + 1}: ${group.missing.join(", ")}`);
    }
  }

  lines.push(
    "",
    "## מה המערכת שולחת למנוע בפועל (Shotstack)",
    shotstackHints
      ? [
          `- מוגדר ספק **Shotstack** (סביבת API לפי הגדרות: **${shotstackHints.apiVersion}**).`,
          `- כל סצנה נשלחת כרינדור נפרד של כ־**${shotstackHints.segmentSeconds} שניות**.`,
          `- רזולוציית פלט: **${shotstackHints.resolution.toUpperCase()}**.`,
          `- דיבור מובנה (Text-to-Speech של Shotstack): **${shotstackHints.textToSpeech ? "מופעל — טקסט הקריינות של הסצנה" : "כבוי"}**.`,
          "- מסלול וידאו: קובץ הרפרנס שנאסף ממאגר המדיה (כשקיים), ללא שמע מהקובץ הזה במסלול הבסיסי.",
          "- **מוזג אחרי הרינדור ב־FFmpeg:** אם נאספו קובץ קול ו/או מוסיקה לסצנה, הם מוזגים לקליפ לאחר קבלת הקובץ מ־Shotstack.",
          "",
          "**חשוב:** טקסט ארוך ב־`instructions.md` או כאן אינו נשלח כפרומפט טקסטואלי ל־Shotstack — רק המבנה של ה־timeline שנבנה בקוד (וידאו + אופציונלי TTS)."
        ].join("\n")
      : [
          "- לא זוהה ספק Shotstack פעיל בהגדרות — במקרה כזה ייתכן שימוש בספק VIDEO אחר או הגדרה חסרה.",
          "- כש־Shotstack פעיל, ראה סעיף למעלה אחרי הגדרת הספק."
        ].join("\n")
  );

  lines.push("", "## Timeline (תזמור תוכנית)", "```json", JSON.stringify(timeline, null, 2), "```");

  return lines.join("\n");
}

function scriptAnalysisSummary(scriptAnalysis: Record<string, unknown>): string {
  if (!scriptAnalysis || Object.keys(scriptAnalysis).length === 0) {
    return "*לא בוצע ניתוח תסריט חכם או שהנתונים ריקים.*";
  }
  const summary = typeof scriptAnalysis.summary === "string" ? scriptAnalysis.summary : undefined;
  const visualDirection = typeof scriptAnalysis.visualDirection === "string" ? scriptAnalysis.visualDirection : undefined;
  const bg = typeof scriptAnalysis.backgroundVideoPrompt === "string" ? scriptAnalysis.backgroundVideoPrompt : undefined;
  const music = typeof scriptAnalysis.musicPrompt === "string" ? scriptAnalysis.musicPrompt : undefined;
  const parts = [
    summary ? `**תקציר:** ${summary}` : undefined,
    visualDirection ? `**כיוון ויזואלי:** ${visualDirection}` : undefined,
    bg ? `**רקע (ניתוח):** ${bg}` : undefined,
    music ? `**מוסיקה (ניתוח):** ${music}` : undefined
  ].filter(Boolean);
  return parts.length ? parts.join("\n\n") : "*ניתוח קיים אך ללא שדות תקציר מוכרים — ראה manifest לפרטים מלאים.*";
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
