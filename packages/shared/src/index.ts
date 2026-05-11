export const videoDurations = [15, 30, 45, 60] as const;
export const aspectRatios = ["9:16", "16:9", "1:1"] as const;
export const creationModes = ["manual", "automatic", "assisted", "series"] as const;

export type VideoDuration = (typeof videoDurations)[number];
export type AspectRatio = (typeof aspectRatios)[number];
export type CreationMode = (typeof creationModes)[number];

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobStage = "script" | "media" | "voice" | "settings" | "render" | "storage" | "distribution";

export interface SceneInput {
  title: string;
  narration: string;
  visualPrompt: string;
  durationSeconds: number;
}

export interface RenderJobPayload {
  jobId: string;
  tenantId: string;
  projectId: string;
}

export interface ApiEnvelope<T> {
  data: T;
}

/** Shotstack/plan-limit style errors — shared by worker, video provider, and web hints */
export function isVideoProviderQuotaOrPlanLimitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("credits exhausted")
    || normalized.includes("credits required")
    || normalized.includes("credits left")
    || normalized.includes("plan limit")
    || normalized.includes("plan limits")
    || normalized.includes("exceeds one or more plan limits")
    || normalized.includes("upgrade to increase your plan limits")
    || message.includes("חסרים קרדיטים")
    || message.includes("מגבלת התוכנית")
  );
}
