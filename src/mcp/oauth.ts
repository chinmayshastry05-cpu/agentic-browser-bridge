/**
 * mcp/oauth.ts — minimal, secure, single-operator OAuth 2.0 authorization
 * server for the MCP Streamable-HTTP transport.
 *
 * Why: ChatGPT's "Add custom MCP server" offers only OAuth / No
 * authentication — there is no bearer/API-key header field, so the static
 * bearer token is unusable from ChatGPT. This implements the MCP
 * authorization spec's required surface for a single-operator setup:
 *
 *   GET  /.well-known/oauth-authorization-server   (RFC 8414 discovery)
 *   POST /register                                  (RFC 7591 dynamic client registration, public clients)
 *   GET  /authorize  +  POST /authorize             (authorization code + PKCE S256, operator-gated)
 *   POST /token                                     (authorization_code + refresh_token grants)
 *
 * Security properties (non-negotiable):
 *  - The pairing code is the ONLY secret here. It comes from
 *    ABB_OAUTH_PAIRING_CODE or is generated at construction, printed
 *    EXACTLY ONCE to stderr, and never stored on disk or in the repo.
 *    Every browser approval requires it (constant-time compare), so a
 *    random internet client can never self-approve.
 *  - Auth codes are 256-bit, 10-minute expiry, single-use, and bound to
 *    (client_id, redirect_uri, PKCE code_challenge).
 *  - redirect_uris must be https: or http: loopback only — no open
 *    redirects to arbitrary sites.
 *  - All stores are in-memory with expiry; revokeAll() wipes everything
 *    when the server stops.
 *  - This file only ISSUES tokens. Enforcement (never allow unauthenticated
 *    /mcp) lives in mcp/server.ts.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 10-minute auth-code lifetime, 1-hour access tokens, 24-hour refresh tokens. */
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const PAIRING_CODE_ENV = 'ABB_OAUTH_PAIRING_CODE';

export interface OAuthProviderOptions {
  /** Public base URL of this server, e.g. "http://127.0.0.1:8933". */
  issuer: string;
  /** Operator pairing code. Falls back to ABB_OAUTH_PAIRING_CODE, else generated. */
  pairingCode?: string;
}

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

export interface ApprovalPageParams {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: string;
}

export type ApprovalPageResult =
  | { ok: true; html: string }
  | { ok: false; error: string };

export interface AuthorizePostResult {
  status: number;
  /** Set for 302 responses. */
  location?: string;
  /** Set for non-redirect error responses. */
  body?: string;
}

export interface TokenIssueResult {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

/** Thrown for OAuth token-grant failures; `code` is the RFC 6749 error code. */
export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
  used: boolean;
}

interface TokenRecord {
  clientId: string;
  expiresAt: number;
}

/** Constant-time string comparison (length-mismatch returns false, no throw). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** PKCE S256: base64url(sha256(verifier)). */
export function pkceS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

function isLoopbackRedirect(uri: URL): boolean {
  const host = uri.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Minimal attribute escaper for injecting validated strings into HTML. */
function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class OAuthProvider {
  readonly issuer: string;
  private readonly pairingCode: string;
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthCodeRecord>();
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();

  constructor(opts: OAuthProviderOptions) {
    this.issuer = opts.issuer;
    this.pairingCode =
      opts.pairingCode ??
      process.env[PAIRING_CODE_ENV] ??
      randomBytes(3).toString('hex'); // 6 hex chars, e.g. "a3f9c2"
    // Printed exactly once; never logged again, never stored, never committed.
    process.stderr.write(
      `[agentic-browser-bridge] MCP OAuth pairing code (shown once, not stored): ${this.pairingCode}\n`,
    );
  }

  /** RFC 8414 authorization-server metadata. */
  discoveryDocument(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: this.issuer + '/authorize',
      token_endpoint: this.issuer + '/token',
      registration_endpoint: this.issuer + '/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    };
  }

  /**
   * RFC 7591 dynamic client registration (public clients only — no secret).
   * Throws OAuthError('invalid_redirect_uri') on validation failure.
   */
  registerClient(body: {
    redirect_uris: string[];
    client_name?: string;
  }): RegisteredClient {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array');
    }
    for (const raw of uris) {
      let uri: URL;
      try {
        uri = new URL(String(raw));
      } catch {
        throw new OAuthError('invalid_redirect_uri', `not a valid URL: ${raw}`);
      }
      const ok =
        uri.protocol === 'https:' ||
        (uri.protocol === 'http:' && isLoopbackRedirect(uri));
      if (!ok) {
        throw new OAuthError(
          'invalid_redirect_uri',
          `redirect_uri must be https: or http: loopback only: ${raw}`,
        );
      }
    }
    const client_id = 'abb-' + randomBytes(8).toString('hex');
    const client: RegisteredClient = {
      client_id,
      redirect_uris: uris.map(String),
      ...(typeof body.client_name === 'string' && body.client_name
        ? { client_name: body.client_name }
        : {}),
    };
    this.clients.set(client_id, client);
    return client;
  }

  /**
   * Build the operator approval page for GET /authorize. Returns an error
   * string (wrapped) instead of HTML when the request is invalid.
   */
  buildApprovalPage(params: ApprovalPageParams): ApprovalPageResult {
    const client = this.clients.get(params.client_id);
    if (!client) return { ok: false, error: 'unknown client_id' };
    if (!client.redirect_uris.includes(params.redirect_uri)) {
      return { ok: false, error: 'redirect_uri is not registered for this client' };
    }
    if (!params.code_challenge) {
      return { ok: false, error: 'code_challenge is required (PKCE S256)' };
    }
    if (params.code_challenge_method !== 'S256') {
      return { ok: false, error: 'only code_challenge_method=S256 is supported' };
    }
    const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize MCP access</title></head>
<body>
<h1>Authorize MCP browser access</h1>
<p>Client <code>${escAttr(params.client_id)}</code> is requesting access to your
<strong>agentic-browser-bridge</strong> MCP server. Approving grants it
control of your browser session — approve only if you initiated this.</p>
<form method="post" action="/authorize">
<input type="hidden" name="client_id" value="${escAttr(params.client_id)}">
<input type="hidden" name="redirect_uri" value="${escAttr(params.redirect_uri)}">
<input type="hidden" name="state" value="${escAttr(params.state ?? '')}">
<input type="hidden" name="code_challenge" value="${escAttr(params.code_challenge)}">
<label for="pairing_code">Pairing code (printed once on the server console):</label>
<input type="text" id="pairing_code" name="pairing_code" autocomplete="off" required>
<br><br>
<button type="submit" name="approved" value="yes">Approve</button>
<button type="submit" name="approved" value="no">Deny</button>
</form>
</body>
</html>`;
    return { ok: true, html };
  }

  /**
   * Handle POST /authorize (urlencoded form). Issues a single-use auth code
   * on operator approval, or bounces back to the client with access_denied.
   */
  handleAuthorizePost(form: Record<string, string>): AuthorizePostResult {
    const clientId = form['client_id'] ?? '';
    const redirectUri = form['redirect_uri'] ?? '';
    const state = form['state'] ?? '';
    const codeChallenge = form['code_challenge'] ?? '';
    const client = this.clients.get(clientId);
    if (!client || !client.redirect_uris.includes(redirectUri) || !codeChallenge) {
      return { status: 400, body: 'invalid authorization request' };
    }
    // Constant-time pairing-code check — a wrong code never reveals anything.
    if (!safeEqual(form['pairing_code'] ?? '', this.pairingCode)) {
      return { status: 403, body: 'invalid pairing code' };
    }
    const redirect = new URL(redirectUri);
    if (form['approved'] !== 'yes') {
      redirect.searchParams.set('error', 'access_denied');
      if (state) redirect.searchParams.set('state', state);
      return { status: 302, location: redirect.toString() };
    }
    const code = randomBytes(32).toString('hex');
    this.codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      used: false,
    });
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);
    return { status: 302, location: redirect.toString() };
  }

  /**
   * Exchange an authorization code for tokens (grant_type=authorization_code).
   * Throws OAuthError('invalid_grant') on any validation failure.
   */
  exchangeCode(args: {
    code: string;
    client_id: string;
    redirect_uri: string;
    code_verifier: string;
  }): TokenIssueResult {
    const rec = this.codes.get(args.code);
    if (
      !rec ||
      rec.used ||
      rec.expiresAt < Date.now() ||
      rec.clientId !== args.client_id ||
      rec.redirectUri !== args.redirect_uri
    ) {
      throw new OAuthError('invalid_grant', 'authorization code is invalid, expired, or already used');
    }
    if (!args.code_verifier || !safeEqual(pkceS256Challenge(args.code_verifier), rec.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'PKCE code_verifier does not match code_challenge');
    }
    rec.used = true; // single-use: mark before issuing so replays fail
    return this.issueTokenPair(rec.clientId);
  }

  /**
   * Rotate a refresh token (grant_type=refresh_token). The old refresh token
   * is revoked; a fresh pair is issued. Throws OAuthError('invalid_grant').
   */
  refreshToken(args: { refresh_token: string; client_id: string }): TokenIssueResult {
    const rec = this.refreshTokens.get(args.refresh_token);
    if (!rec || rec.expiresAt < Date.now() || rec.clientId !== args.client_id) {
      throw new OAuthError('invalid_grant', 'refresh token is invalid or expired');
    }
    this.refreshTokens.delete(args.refresh_token); // rotation: revoke the old one
    return this.issueTokenPair(rec.clientId);
  }

  private issueTokenPair(clientId: string): TokenIssueResult {
    const now = Date.now();
    const access_token = randomBytes(32).toString('hex');
    const refresh_token = randomBytes(32).toString('hex');
    this.accessTokens.set(access_token, { clientId, expiresAt: now + ACCESS_TOKEN_TTL_MS });
    this.refreshTokens.set(refresh_token, { clientId, expiresAt: now + REFRESH_TOKEN_TTL_MS });
    return { access_token, token_type: 'Bearer', expires_in: 3600, refresh_token };
  }

  /** Validate a bearer access token → owning clientId, or null. */
  validateToken(token: string): string | null {
    const rec = this.accessTokens.get(token);
    if (!rec) return null;
    if (rec.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      return null;
    }
    return rec.clientId;
  }

  /** Wipe every in-memory store (called on server stop). */
  revokeAll(): void {
    this.clients.clear();
    this.codes.clear();
    this.accessTokens.clear();
    this.refreshTokens.clear();
  }
}
