const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}/api${path}`);
  if (!response.ok) {
    throw new Error(await response.text());
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
    throw new Error(await response.text());
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
