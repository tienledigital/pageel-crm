// @para-doc [plan-v0.10.0#phase-7-csrf-protection]
// CSRF Protection — Origin header validation

// Webhook endpoints that bypass CSRF checks (external services need to POST)
const CSRF_EXEMPT_PATHS = [
  '/api/webhook/sepay',
];

/**
 * Validate that a request's Origin matches the expected host.
 * Returns true if the request should be allowed, false if it should be blocked.
 *
 * Rules:
 * - Requests to CSRF-exempt paths (webhooks) are always allowed.
 * - If Origin is null/missing, allow (same-origin form submit or non-CORS request).
 * - If Origin matches the host, allow.
 * - Otherwise, block.
 */
// @para-doc [auth-spec.md#44-phong-chong-tan-cong-csrf-bang-origin-validation-csrf-protection]
export function validateOrigin(
  origin: string | null,
  host: string,
  pathname: string
): boolean {
  // 1. Exempt webhook paths
  if (CSRF_EXEMPT_PATHS.some((path) => pathname === path || pathname.startsWith(path + '/'))) {
    return true;
  }

  // 2. No Origin header — same-origin navigational request (allow)
  if (!origin) {
    return true;
  }

  // 3. Parse origin to extract hostname
  try {
    const originUrl = new URL(origin);
    // Compare just the hostname (ignore port for flexibility in dev)
    return originUrl.hostname === host || originUrl.host === host;
  } catch {
    // Invalid origin — reject
    return false;
  }
}
