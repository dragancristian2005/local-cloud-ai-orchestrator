export class HttpError extends Error {
  status: number;

  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new HttpError(response.status, url);
  }
  return (await response.json()) as T;
}
