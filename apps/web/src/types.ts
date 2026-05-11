/** JSON בשדה project.materialLibrary — נוצר אחרי איסוף חומרים */
export type MaterialLibraryJson = Record<string, unknown> & {
  previewBrief?: string;
};

/** JSON בשדה project.renderPackage — נוצר אחרי בניית חבילת רינדור */
export type RenderPackageJson = Record<string, unknown> & {
  renderEnginePromptBrief?: string;
  shotstackHints?: {
    segmentSeconds: number;
    resolution: string;
    textToSpeech: boolean;
    apiVersion: string;
  };
};

export interface Scene {
  id: string;
  title: string;
  narration: string;
  visualPrompt: string;
  durationSeconds: number;
  order: number;
  mediaUrl?: string | null;
  voiceUrl?: string | null;
  musicUrl?: string | null;
  clipUrl?: string | null;
  referenceMediaUrl?: string | null;
  generatedVideoUrl?: string | null;
  videoProvider?: string | null;
  videoPrompt?: string | null;
  generationStatus?: "generated" | "fallback" | "failed" | string | null;
}

export interface RenderJob {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  stage: string;
  progress: number;
  outputUrl?: string | null;
  error?: string | null;
  createdAt?: string;
  updatedAt: string;
  project?: Project;
}

export interface Project {
  id: string;
  title: string;
  sourceText: string;
  mode: string;
  duration: number;
  aspectRatio: string;
  backgroundVideoPrompt?: string | null;
  musicPrompt?: string | null;
  scriptAnalysis?: Record<string, unknown> | null;
  materialLibrary?: MaterialLibraryJson | null;
  renderPackage?: RenderPackageJson | null;
  renderPackageApprovedAt?: string | null;
  status: string;
  scenes: Scene[];
  renderJobs?: RenderJob[];
}

export interface Asset {
  id: string;
  type: string;
  name: string;
  url: string;
  mimeType?: string;
  tags: string[];
}

export interface Provider {
  id: string;
  type: string;
  provider: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  hasSecret: boolean;
  config?: Record<string, unknown>;
}

export interface AuditLog {
  id: string;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
