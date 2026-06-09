// @para-doc [plan-v0.10.0#phase-7-ssrf-mitigation]
// URL Validator — SSRF mitigation for backup restore endpoint

// Only allow these domains for backup restore downloads
const ALLOWED_HOSTS = [
  'api.github.com',
  'raw.githubusercontent.com',
  'github.com',
];

/**
 * Validate that a restore download URL is safe (not an SSRF vector).
 * Returns true only for HTTPS URLs pointing to allowed GitHub domains.
 */
// @para-doc [auth-spec.md#45-bao-ve-api-restore-chong-tan-cong-ssrf-server-side-request-forgery]
export function validateRestoreUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // 1. Must be HTTPS
    if (parsed.protocol !== 'https:') {
      return false;
    }

    // 2. Must be an allowed host
    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
      return false;
    }

    return true;
  } catch {
    // Invalid URL — reject
    return false;
  }
}
