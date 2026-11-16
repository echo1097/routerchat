const AUTH_LOST_EVENT = "routerchat:auth-lost";
const AUTH_REQUIRED_CODE = "api_auth_required";

export function isAuthRequired(code) {
  return code === AUTH_REQUIRED_CODE;
}

export function reportAuthLost(code) {
  if (!isAuthRequired(code)) return;
  window.dispatchEvent(new Event(AUTH_LOST_EVENT));
}

export function onAuthLost(handler) {
  window.addEventListener(AUTH_LOST_EVENT, handler);
  return () => window.removeEventListener(AUTH_LOST_EVENT, handler);
}
