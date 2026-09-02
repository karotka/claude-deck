const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Which pages may call this API from a browser.
 *
 * The server has no authentication: it can read every transcript on the machine
 * and type into live sessions. Reflecting any origin (`origin: true`) would let
 * any site the user happens to visit do both. So a request is allowed only when
 * it is same-origin — no `Origin` header, or one matching the host the request
 * was addressed to — or when it comes from a page served from this machine,
 * which is what the UI dev server on another port is.
 */
export function isAllowedOrigin(origin?: string, host?: string): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) return true;
  return !!host && url.host === host;
}
