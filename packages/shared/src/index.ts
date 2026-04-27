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
