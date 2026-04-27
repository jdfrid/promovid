export interface Scene {
  id: string;
  title: string;
  narration: string;
  visualPrompt: string;
  durationSeconds: number;
  order: number;
}

export interface RenderJob {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  stage: string;
  progress: number;
  outputUrl?: string | null;
  error?: string | null;
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
}
