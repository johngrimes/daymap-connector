import crypto from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { DaymapAuthError, type DaymapSchool, type DaymapTokens } from "./session.js";

/**
 * The OAuth 2.1 authorisation server for the hosted connector.
 *
 * Claude registers itself dynamically and sends the parent to /authorize, where they
 * sign in with their own Daymap username and password. Only usernames on the allowlist
 * may sign in. The password goes straight to Daymap and is never kept: what the
 * connector keeps is Daymap's tokens for that parent, encrypted inside the OAuth tokens
 * it gives Claude. Everything is stateless: client IDs, authorisation codes and tokens
 * are AES-256-GCM-encrypted blobs, so the server can restart (or run more than one
 * replica) without anyone signing in again. Refreshing Claude's token refreshes the
 * Daymap one; when Daymap refuses that, the parent has to connect again. Changing the
 * signing secret invalidates every token.
 */

export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

const CODE_TTL = 5 * 60;
const MAX_ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;
const PENDING_TTL = 10 * 60;
/** Expire Claude's access token this long before the Daymap token inside it. */
const EXPIRY_MARGIN = 60;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface AuthOptions {
  /** The school whose parents sign in. */
  school: DaymapSchool;
  /** Daymap usernames allowed to sign in (matched case-insensitively). Must not be empty. */
  allowedUsers: string[];
  /** Secret key the token encryption key is derived from (at least 32 characters). */
  signingSecret: string;
  /** Redirect URIs clients may register. Defaults to Claude's OAuth callbacks. */
  allowedRedirectUris?: string[];
  /** Name shown on the sign-in page. */
  title?: string;
}

type Claims = Record<string, unknown> & { typ: string; exp: number };

const now = () => Math.floor(Date.now() / 1000);
const normaliseUser = (user: string) => user.trim().toLowerCase();

/** The Daymap access token carried by a verified connector access token. */
export function daymapAccessToken(auth: AuthInfo): string {
  const token = auth.extra?.daymapAccessToken;
  if (typeof token !== "string") throw new Error("The access token doesn't carry a Daymap sign-in.");
  return token;
}

export class DaymapAuthProvider implements OAuthServerProvider {
  private readonly encryptionKey: Buffer;
  private readonly macKey: Buffer;
  private readonly school: DaymapSchool;
  private readonly allowedUsers: Set<string>;
  private readonly allowedRedirectUris: string[];
  /** Authorisation codes already exchanged (best-effort replay protection). */
  private readonly usedCodes = new Map<string, number>();
  readonly title: string;

  constructor(opts: AuthOptions) {
    if (!opts.signingSecret || opts.signingSecret.length < 32) {
      throw new Error("The token signing secret must be at least 32 characters.");
    }
    this.allowedUsers = new Set(opts.allowedUsers.map(normaliseUser).filter(Boolean));
    if (this.allowedUsers.size === 0) {
      throw new Error("At least one Daymap username must be allowed to sign in.");
    }
    const derive = (info: string) =>
      Buffer.from(crypto.hkdfSync("sha256", opts.signingSecret, Buffer.alloc(0), `daymap-connector:${info}`, 32));
    this.encryptionKey = derive("token-encryption");
    this.macKey = derive("client-secret");
    this.school = opts.school;
    this.allowedRedirectUris = opts.allowedRedirectUris?.length
      ? opts.allowedRedirectUris
      : DEFAULT_REDIRECT_URIS;
    this.title = opts.title ?? "Daymap";
  }

  // --- sealing -----------------------------------------------------------------

  /** Encrypts and authenticates claims; the type is bound as associated data. */
  private seal(claims: Claims): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(claims.typ));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims)), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
  }

  private unseal(token: string, typ: string): Claims | null {
    const raw = Buffer.from(token, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES || raw.toString("base64url") !== token) return null;
    let claims: Claims;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(typ));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const plaintext = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
      claims = JSON.parse(plaintext.toString());
    } catch {
      return null;
    }
    if (claims.typ !== typ || typeof claims.exp !== "number" || claims.exp < now()) return null;
    return claims;
  }

  private isAllowed(user: unknown): boolean {
    return typeof user === "string" && this.allowedUsers.has(normaliseUser(user));
  }

  // --- clients -----------------------------------------------------------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      registerClient: (client) => {
        for (const uri of client.redirect_uris) {
          if (!this.allowedRedirectUris.includes(uri)) {
            throw new InvalidClientMetadataError(`redirect_uri ${uri} is not allowed by this server`);
          }
        }
        const { client_secret: _s, client_secret_expires_at: _e, ...metadata } = client as OAuthClientInformationFull;
        const clientId = this.seal({
          typ: "client",
          exp: Number.MAX_SAFE_INTEGER,
          iat: now(),
          md: metadata,
        });
        return this.describeClient(clientId)!;
      },
      getClient: (clientId) => this.describeClient(clientId),
    };
  }

  private describeClient(clientId: string): OAuthClientInformationFull | undefined {
    const claims = this.unseal(clientId, "client");
    if (!claims) return undefined;
    const metadata = claims.md as OAuthClientInformationFull;
    const isPublic = metadata.token_endpoint_auth_method === "none";
    return {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: claims.iat as number,
      // Confidential clients get a secret derived from their ID, so nothing is stored.
      ...(isPublic
        ? {}
        : {
            client_secret: crypto.createHmac("sha256", this.macKey).update(clientId).digest("base64url"),
            client_secret_expires_at: 0,
          }),
    };
  }

  // --- authorisation -----------------------------------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pending = this.seal({
      typ: "pending",
      exp: now() + PENDING_TTL,
      cid: client.client_id,
      cn: client.client_name,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: params.scopes ?? [],
      rs: params.resource?.toString(),
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:");
    res.setHeader("X-Frame-Options", "DENY");
    res.status(200).type("html").send(this.loginPage(pending, client.client_name));
  }

  /**
   * Handles the sign-in form: checks the allowlist, then signs in to Daymap. Returns
   * the URL to redirect the browser to, or an HTML page to show again with an error and
   * its HTTP status (always 4xx/5xx, so only failed attempts count towards rate limits).
   */
  async completeLogin(
    pendingToken: string,
    username: string,
    password: string,
  ): Promise<{ redirect: string } | { html: string; status: number }> {
    const pending = this.unseal(pendingToken, "pending");
    if (!pending) {
      return {
        html: this.messagePage("This sign-in link has expired. Go back to Claude and try connecting again."),
        status: 400,
      };
    }
    const user = username.trim();
    const retry = (status: number, error: string) => ({
      html: this.loginPage(pendingToken, pending.cn as string | undefined, error, user),
      status,
    });
    if (!user || !password) return retry(400, "Enter your Daymap username and password.");
    // Checked before contacting Daymap, so the connector can't be used to try passwords for other accounts.
    if (!this.isAllowed(user)) return retry(403, "That Daymap account isn't allowed to use this connector.");

    let daymap: DaymapTokens;
    try {
      daymap = await this.school.signIn(user, password);
    } catch (err) {
      if (err instanceof DaymapAuthError) return retry(400, `Daymap didn't accept that sign-in: ${err.message}`);
      console.error("Daymap sign-in failed:", err);
      return retry(502, "Couldn't sign in to Daymap just now. Try again in a minute.");
    }

    const code = this.seal({
      typ: "code",
      exp: now() + CODE_TTL,
      jti: crypto.randomUUID(),
      cid: pending.cid,
      ru: pending.ru,
      cc: pending.cc,
      sc: pending.sc,
      rs: pending.rs,
      u: user,
      dt: daymap,
    });
    const target = new URL(pending.ru as string);
    target.searchParams.set("code", code);
    if (pending.st !== undefined) target.searchParams.set("state", pending.st as string);
    return { redirect: target.toString() };
  }

  private codeClaims(client: OAuthClientInformationFull, code: string): Claims {
    const claims = this.unseal(code, "code");
    if (!claims || claims.cid !== client.client_id || !this.isAllowed(claims.u)) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return claims;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.codeClaims(client, code).cc as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const claims = this.codeClaims(client, code);
    if (redirectUri !== undefined && redirectUri !== claims.ru) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.pruneUsedCodes();
    const jti = claims.jti as string;
    if (this.usedCodes.has(jti)) throw new InvalidGrantError("Authorization code already used");
    this.usedCodes.set(jti, claims.exp);
    return this.issueTokens(
      client.client_id,
      claims.sc as string[],
      claims.rs as string | undefined,
      claims.u as string,
      claims.dt as DaymapTokens,
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const claims = this.unseal(refreshToken, "refresh");
    if (!claims || claims.cid !== client.client_id || !this.isAllowed(claims.u)) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    const granted = claims.sc as string[];
    if (scopes?.some((s) => !granted.includes(s))) {
      throw new InvalidGrantError("Requested scopes exceed those originally granted");
    }
    let daymap: DaymapTokens;
    try {
      daymap = await this.school.refresh(claims.rt as string);
    } catch (err) {
      if (err instanceof DaymapAuthError) {
        throw new InvalidGrantError(`Daymap ended this sign-in; connect again. (${err.message})`);
      }
      console.error("Refreshing the Daymap sign-in failed:", err);
      throw new ServerError("Couldn't reach Daymap to refresh the sign-in");
    }
    return this.issueTokens(
      client.client_id,
      scopes?.length ? scopes : granted,
      claims.rs as string | undefined,
      claims.u as string,
      daymap,
    );
  }

  /**
   * Issues Claude's tokens around the parent's Daymap tokens. The access token expires
   * just before the Daymap access token inside it, so Claude refreshes in time. Without
   * a Daymap refresh token there is no refresh token, and the parent connects again.
   */
  private issueTokens(clientId: string, scopes: string[], resource: string | undefined, user: string, daymap: DaymapTokens): OAuthTokens {
    const base = { cid: clientId, sc: scopes, rs: resource, u: user };
    const lifetime = Math.floor(daymap.expiresAt / 1000) - now();
    const accessTtl = Math.max(0, Math.min(MAX_ACCESS_TTL, lifetime - Math.min(EXPIRY_MARGIN, Math.floor(lifetime / 2))));
    return {
      access_token: this.seal({ typ: "access", exp: now() + accessTtl, ...base, at: daymap.access }),
      ...(daymap.refresh
        ? { refresh_token: this.seal({ typ: "refresh", exp: now() + REFRESH_TTL, ...base, rt: daymap.refresh }) }
        : {}),
      token_type: "bearer",
      expires_in: accessTtl,
      scope: scopes.join(" ") || undefined,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = this.unseal(token, "access");
    if (!claims || !this.isAllowed(claims.u)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: claims.cid as string,
      scopes: claims.sc as string[],
      expiresAt: claims.exp,
      resource: claims.rs ? new URL(claims.rs as string) : undefined,
      extra: { daymapAccessToken: claims.at, daymapUser: claims.u },
    };
  }

  private pruneUsedCodes() {
    const t = now();
    for (const [jti, exp] of this.usedCodes) if (exp < t) this.usedCodes.delete(jti);
  }

  // --- pages -------------------------------------------------------------------

  private page(body: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(this.title)} connector</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: Canvas; color: CanvasText; }
  main { width: min(360px, calc(100vw - 32px)); }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  p { margin: .25rem 0 1rem; opacity: .8; }
  label { display: block; font-weight: 600; margin: .75rem 0 .25rem; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: .6rem .7rem; border: 1px solid GrayText; border-radius: 8px; }
  button { margin-top: 1rem; width: 100%; font: inherit; font-weight: 600; padding: .6rem; border: 0; border-radius: 8px;
           background: #2f6fde; color: white; cursor: pointer; }
  .error { color: #c62828; font-weight: 600; }
</style></head><body><main>${body}</main></body></html>`;
  }

  private loginPage(pending: string, clientName?: string, error?: string, username = ""): string {
    const who = clientName ? escapeHtml(clientName) : "An application";
    return this.page(`<h1>Connect to ${escapeHtml(this.title)}</h1>
<p>${who} wants to use your Daymap family portal account: reading it and, when you approve, acting on your behalf (for example replying to messages). Sign in with your Daymap username and password. Your password is only sent to Daymap, and isn't stored.</p>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="login">
  <input type="hidden" name="pending" value="${escapeHtml(pending)}">
  <label for="username">Daymap username</label>
  <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="${escapeHtml(username)}" required${username ? "" : " autofocus"}>
  <label for="password">Daymap password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required${username ? " autofocus" : ""}>
  <button type="submit">Sign in</button>
</form>`);
  }

  messagePage(message: string): string {
    return this.page(`<h1>${escapeHtml(this.title)}</h1><p>${escapeHtml(message)}</p>`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
