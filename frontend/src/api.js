

export async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return response.json();
}

export async function responseError(response) {
  const fallback = response.statusText || "Request failed";
  const body = await response.text();
  let payload = null;

  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
  }

  const detail = payload?.detail;
  const message = typeof detail === "string"
    ? detail
    : detail?.message || payload?.error?.message || body || fallback;
  const error = new Error(message);
  error.name = "ApiError";
  error.status = response.status;
  error.payload = payload;
  error.code = detail?.code || payload?.error?.code || payload?.code || null;
  error.chapter = detail?.chapter || payload?.chapter || null;
  return error;
}

export async function responseErrorDetail(response) {
  const error = await responseError(response);
  return error.message;
}
