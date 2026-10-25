/**
 * Anonymous session handling.
 *
 * Pixel Commons deliberately collects as little as possible: no email, no password,
 * no fingerprinting. Every visitor gets a random 128-bit session id inside an
 * HMAC-signed, HttpOnly cookie. The public display handle is derived from the
 * session id with a one-way hash, so it is stable for the session but reveals
 * nothing about the device or network.
 *
 * Because the cookie is HttpOnly + SameSite=Lax and the WebSocket upgrade request
 * carries it, the server -not the client -always owns the identity. A malicious
 * client cannot claim another user's cooldown budget by simply editing a field in
 * the WebSocket message.
 */

const COOKIE_NAME = 'pc_sid';
const ADMIN_COOKIE = 'pc_admin';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const ANIMALS = [
  'otter', 'falcon', 'moth', 'heron', 'lynx', 'gecko', 'raven', 'bison',
  'koi', 'pika', 'tapir', 'wren', 'marmot', 'crane', 'dingo', 'ibis',
  'lemur', 'narwhal', 'ocelot', 'panda', 'quokka', 'shrew', 'tern', 'vole',
];

const ADJECTIVES = [
  'amber', 'brisk', 'cobalt', 'dusty', 'ember', 'frosty', 'glossy', 'hazel',
  'indigo', 'jade', 'kind', 'lunar', 'mossy', 'neon', 'opal', 'plum',
  'quiet', 'rust', 'sage', 'teal', 'umber', 'velvet', 'wispy', 'zesty',
];

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(sig));
}

async function verify(secret: string, payload: string, signature: string): Promise<boolean> {
  try {
    const key = await hmacKey(secret);
    const raw = fromB64url(signature);
    return await crypto.subtle.verify(
      'HMAC',
      key,
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/**
 * Session cookie.
 *
 * `crossSite` is set when the browser talks to this API from a different origin
 * (the static GitHub Pages build). Cross-site cookies require `SameSite=None`,
 * which in turn requires `Secure`, so that combination is only emitted for HTTPS
 * requests. Same-origin deployments keep the stricter `SameSite=Lax`.
 */
export function sessionCookie(sessionId: string, secure: boolean, crossSite = false): string {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE}`,
    'HttpOnly',
    crossSite && secure ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function adminCookie(token: string, secure: boolean, crossSite = false): string {
  const attrs = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'Max-Age=3600',
    'HttpOnly',
    crossSite && secure ? 'SameSite=None' : 'SameSite=Strict',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearAdminCookie(secure: boolean): string {
  const attrs = [`${ADMIN_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export const ADMIN_COOKIE_NAME = ADMIN_COOKIE;

/**
 * Resolve the session for an incoming request.
 *
 * Returns the session id and whether a `Set-Cookie` header is needed. The session
 * cookie only stores the random id; the signature lives in a second cookie field so
 * a forged cookie without a valid HMAC is simply replaced with a fresh identity
 * instead of being trusted.
 */
export async function resolveSession(
  request: Request,
  secret: string,
): Promise<{ sessionId: string; issueCookie: boolean; isAdmin: boolean }> {
  const raw = readCookie(request, COOKIE_NAME);
  let sessionId: string | null = null;
  if (raw && raw.includes('.')) {
    const [id, sig] = raw.split('.') as [string, string];
    if (/^[A-Za-z0-9_-]{16,64}$/.test(id) && sig && (await verify(secret, id, sig))) {
      sessionId = id;
    }
  }
  const adminToken = readCookie(request, ADMIN_COOKIE);
  const isAdmin = Boolean(adminToken && (await verify(secret, 'admin', adminToken)));
  if (!sessionId) {
    sessionId = randomId(16);
    return { sessionId, issueCookie: true, isAdmin };
  }
  return { sessionId, issueCookie: false, isAdmin };
}

export async function signedSessionValue(secret: string, sessionId: string): Promise<string> {
  return `${sessionId}.${await sign(secret, sessionId)}`;
}

export async function signAdmin(secret: string): Promise<string> {
  return sign(secret, 'admin');
}

/** Stable, non-identifying public handle for a session id. */
export async function handleFor(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('handle:' + sessionId));
  const view = new DataView(digest);
  const adj = ADJECTIVES[view.getUint32(0) % ADJECTIVES.length]!;
  const animal = ANIMALS[view.getUint32(4) % ANIMALS.length]!;
  const num = (view.getUint32(8) % 900) + 100;
  return `${adj}-${animal}-${num}`;
}

/** Constant-time-ish comparison for the admin token. */
export function safeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i]! ^ bBytes[i]!;
  return diff === 0;
}
