import type { SceneInput } from "@promovid/shared";

interface ScriptRequest {
  sourceText: string;
  duration: number;
  style?: string;
  targetAudience?: string;
}

export async function generateScript(request: ScriptRequest): Promise<SceneInput[]> {
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
