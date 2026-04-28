const apiUrl = import.meta.env.VITE_API_URL ?? "";

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}/api${path}`);
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  const envelope = (await response.json()) as { data: T };
  return envelope.data;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}/api${path}`, {
    method: "POST",
    headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body ?? {})
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  const envelope = (await response.json()) as { data: T };
  return envelope.data;
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}/api${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  const envelope = (await response.json()) as { data: T };
  return envelope.data;
}

export function absoluteAssetUrl(url?: string | null) {
  if (!url) {
    return "";
  }
  if (url.startsWith("http")) {
    return url;
  }
  return `${apiUrl}${url}`;
}

async function readApiError(response: Response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? text;
  } catch {
    return text;
  }
}
