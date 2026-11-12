/** Minimal JSON HTTP helpers shared by the handlers. */

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  // The device client and any local test page read this API from another origin.
  'access-control-allow-origin': '*',
};

export function json(statusCode: number, body: unknown): ApiResponse {
  return { statusCode, headers: { ...BASE_HEADERS }, body: JSON.stringify(body) };
}

export function badRequest(message: string): ApiResponse {
  return json(400, { error: 'bad_request', message });
}

export function notFound(message: string): ApiResponse {
  return json(404, { error: 'not_found', message });
}
