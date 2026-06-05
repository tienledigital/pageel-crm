import { env } from 'cloudflare:workers';

// @para-doc [auth-spec.md#secret-management]
export function getSessionSecret(): string {
  const secret = env?.SESSION_SECRET || import.meta.env.SESSION_SECRET || (typeof process !== 'undefined' ? process.env.SESSION_SECRET : undefined);
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is not configured. Set it in .dev.vars (local) or Cloudflare secrets (production).'
    );
  }
  return secret;
}

// @para-doc [auth-spec.md#2-co-che-session-cookie-khong-luu-trang-thai-stateless-signed-cookie]
export interface SessionPayload {
  id: string;
  username: string;
  role: string;
  createdAt: number;
}

// Helper to convert Uint8Array to Hex string
// @para-doc [auth-spec.md#22-cac-ham-tien-ich-ma-hoa-crypto-encoding-helpers]
function toHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper to convert Hex string to Uint8Array
// @para-doc [auth-spec.md#22-cac-ham-tien-ich-ma-hoa-crypto-encoding-helpers]
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Helper to decode Base64URL to string
// @para-doc [auth-spec.md#22-cac-ham-tien-ich-ma-hoa-crypto-encoding-helpers]
function base64urlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(base64, 'base64').toString('utf-8');
  }
  return atob(base64);
}

// Helper to encode string to Base64URL
// @para-doc [auth-spec.md#22-cac-ham-tien-ich-ma-hoa-crypto-encoding-helpers]
function base64urlEncode(str: string): string {
  let base64 = '';
  if (typeof Buffer !== 'undefined') {
    base64 = Buffer.from(str).toString('base64');
  } else {
    base64 = btoa(str);
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// @para-doc [auth-spec.md#1-thuat-toan-bam-mat-khau-password-hashing]
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 10000,
      hash: 'SHA-256',
    },
    baseKey,
    256 // 32 bytes
  );

  const saltHex = toHex(salt);
  const hashHex = toHex(new Uint8Array(derivedBits));

  return `pbkdf2:10000:${saltHex}:${hashHex}`;
}

// @para-doc [auth-spec.md#1-thuat-toan-bam-mat-khau-password-hashing]
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash.startsWith('pbkdf2:10000:')) {
    return false;
  }

  const parts = storedHash.split(':');
  if (parts.length !== 4) {
    return false;
  }

  const [, , saltHex, hashHex] = parts;
  const salt = fromHex(saltHex);
  const originalHash = fromHex(hashHex);

  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 10000,
      hash: 'SHA-256',
    },
    baseKey,
    256 // 32 bytes
  );

  const newHash = new Uint8Array(derivedBits);

  if (newHash.length !== originalHash.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < newHash.length; i++) {
    diff |= newHash[i] ^ originalHash[i];
  }

  return diff === 0;
}

// @para-doc [auth-spec.md#quy-trinh-ky-va-xac-thuc-hmac-signature-flow]
export async function createSessionCookie(payload: SessionPayload, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const payloadStr = JSON.stringify(payload);
  const payloadBase64 = base64urlEncode(payloadStr);

  const secretBuffer = encoder.encode(secret);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const payloadBuffer = encoder.encode(payloadBase64);
  const signatureBuffer = await crypto.subtle.sign('HMAC', hmacKey, payloadBuffer);
  const signatureHex = toHex(new Uint8Array(signatureBuffer));

  return `${payloadBase64}.${signatureHex}`;
}

// @para-doc [auth-spec.md#quy-trinh-ky-va-xac-thuc-hmac-signature-flow]
export async function verifySessionCookie(cookieValue: string, secret: string): Promise<SessionPayload | null> {
  const parts = cookieValue.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [payloadBase64, signatureHex] = parts;
  const encoder = new TextEncoder();

  try {
    const secretBuffer = encoder.encode(secret);
    const hmacKey = await crypto.subtle.importKey(
      'raw',
      secretBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const payloadBuffer = encoder.encode(payloadBase64);
    const signatureBytes = fromHex(signatureHex);

    const isValid = await crypto.subtle.verify(
      'HMAC',
      hmacKey,
      signatureBytes.buffer as ArrayBuffer,
      payloadBuffer
    );

    if (!isValid) {
      return null;
    }

    const payloadStr = base64urlDecode(payloadBase64);
    const payload = JSON.parse(payloadStr) as SessionPayload;

    // TTL check: reject sessions older than 7 days (must match cookie maxAge)
    const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    if (payload.createdAt && (Date.now() - payload.createdAt) > SESSION_TTL_MS) {
      return null;
    }

    return payload;
  } catch (e) {
    return null;
  }
}
