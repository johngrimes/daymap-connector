import crypto from "node:crypto";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

/** Tokens from Daymap's identity server for one signed-in parent. */
export interface DaymapTokens {
  access: string;
  refresh?: string;
  /** When the access token expires, in milliseconds since the epoch. */
  expiresAt: number;
}

/** Daymap refused a sign-in or token grant (as opposed to being unreachable or broken). */
export class DaymapAuthError extends Error {}

/** A Daymap API call that came back with an error status. */
export class DaymapApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** The family portal's OAuth client, as registered with Daymap's identity server. */
const CLIENT_ID = "Connect.API";
const SCOPE = "openid offline_access";
/** Tells the API which Daymap app is calling (ApplicationType.ParentPortal). */
const APPLICATION_TYPE = "2";
const API_PREFIX = "/lms/api/";
const MAX_HOPS = 20;
const USER_AGENT =
  "Mozilla/5.0 (compatible; daymap-connector/0.4; +https://github.com/johngrimes/daymap-connector)";

interface IdentityEndpoints {
  authorize: string;
  token: string;
}

/**
 * Normalises an API path the way the server could see it so that blocked paths can't
 * be reached by encoding tricks: percent-decoded repeatedly, backslashes as slashes,
 * repeated slashes collapsed, "." and ".." segments resolved, lower case. Returns null
 * (fail closed) when the path has a malformed escape or is still encoded after several
 * rounds of decoding.
 */
function canonicalPath(pathname: string): string | null {
  let decoded = pathname;
  for (let round = 0; decoded.includes("%"); round++) {
    if (round === 5) return null;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }
  const slashed = decoded.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  // Resolve dot segments; "?" and "#" are escaped so they stay part of the path.
  const resolved = new URL(slashed.replace(/\?/g, "%3F").replace(/#/g, "%23"), "http://x").pathname;
  return decodeURIComponent(resolved).toLowerCase();
}

/** Paths that can't be decoded with certainty count as blocked. */
const blocked = (pattern: RegExp) => (pathname: string) => {
  const path = canonicalPath(pathname);
  return path === null || pattern.test(path);
};

/** Payment endpoints may be read but never written to. */
export const isPaymentPath = blocked(/^\/lms\/api\/payments(?:$|[^a-z0-9_-])/);

/**
 * GET endpoints that change state (they mark notifications or announcements read).
 * The read-only tools must never call them.
 */
export const isStateChangingGet = blocked(
  /^\/lms\/api\/coms\/(?:notifications\/(?:setread|announcementread)|alerts)(?:$|[^a-z0-9_-])/,
);

/** Saving a form record, which must go through the tool that refuses payment fields. */
export const isFormSavePath = blocked(/^\/lms\/api\/forms\/record\/save(?:$|[^a-z0-9_-])/);

/**
 * A school's Daymap site and its identity server.
 *
 * The family portal is a single-page app that signs in to Daymap's identity server
 * (OpenID Connect, authorisation code with PKCE) as the public client "Connect.API"
 * and calls the API with a Bearer token. This class does the same server-side for any
 * parent: it follows the authorise redirects to the identity server's login form,
 * posts their credentials, catches the redirect back to the portal's callback URL and
 * exchanges the code for tokens. It keeps no per-parent state.
 */
export class DaymapSchool {
  readonly origin: string;
  private readonly redirectUri: string;
  private endpoints: Promise<IdentityEndpoints> | null = null;

  constructor(baseUrl: string) {
    this.origin = new URL(baseUrl).origin;
    this.redirectUri = `${this.origin}/portals/family/auth`;
  }

  /**
   * Resolves a path or URL to an API URL on the school site. Only /lms/api/ on the
   * configured host is allowed, so tokens are never sent anywhere else.
   */
  apiUrl(pathOrUrl: string): URL {
    const raw = pathOrUrl.trim();
    const url = new URL(raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `/${raw}`, this.origin);
    if (url.origin !== this.origin) {
      throw new Error(`Refusing to call ${url.origin}: only ${this.origin} is allowed.`);
    }
    const path = canonicalPath(url.pathname);
    if (path === null) {
      throw new Error(`Refusing ${url.pathname}: it has malformed or nested percent-encoding.`);
    }
    if (!path.startsWith(API_PREFIX)) {
      throw new Error(`Only Daymap API paths under ${API_PREFIX} can be called (got ${url.pathname}).`);
    }
    return url;
  }

  /** API access as the parent the access token belongs to. */
  session(accessToken: string): DaymapSession {
    return new DaymapSession(this, accessToken);
  }

  /**
   * Signs in with a parent's username and password. Throws DaymapAuthError when Daymap
   * refuses them, with Daymap's own message where it gives one.
   */
  async signIn(username: string, password: string): Promise<DaymapTokens> {
    const { authorize } = await this.identityEndpoints();
    const verifier = crypto.randomBytes(32).toString("base64url");
    const state = crypto.randomBytes(16).toString("base64url");
    const start = new URL(authorize);
    start.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: SCOPE,
      state,
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      response_mode: "query",
      // The portal sends its callback URL here too; the identity server uses it to brand the login page.
      acr_values: this.redirectUri,
    }).toString();

    const code = await this.authorize(start.toString(), state, username, password);
    return this.tokenGrant({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      code_verifier: verifier,
    });
  }

  /**
   * Swaps a refresh token for fresh tokens. Throws DaymapAuthError when Daymap refuses
   * it (expired or revoked), and a plain Error when Daymap can't be reached.
   */
  refresh(refreshToken: string): Promise<DaymapTokens> {
    return this.tokenGrant({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private identityEndpoints(): Promise<IdentityEndpoints> {
    if (!this.endpoints) {
      this.endpoints = (async () => {
        const discover = DiscoverSchema.safeParse(await fetchJson(`${this.origin}/daymap/dws/discover.ashx`));
        if (!discover.success) {
          throw new Error("The school's Daymap site didn't say which identity server it uses.");
        }
        const idserver = discover.data.idserver.replace(/\/+$/, "");
        const meta = OpenIdMetadataSchema.safeParse(await fetchJson(`${idserver}/.well-known/openid-configuration`));
        if (!meta.success) {
          throw new Error(`Daymap's identity server (${idserver}) returned incomplete OpenID metadata.`);
        }
        return { authorize: meta.data.authorization_endpoint, token: meta.data.token_endpoint };
      })().catch((err) => {
        this.endpoints = null;
        throw err;
      });
    }
    return this.endpoints;
  }

  private async tokenGrant(params: Record<string, string>): Promise<DaymapTokens> {
    const { token } = await this.identityEndpoints();
    const res = await fetch(token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
    });
    const body: unknown = await res.json().catch(() => undefined);
    const parsed = TokenResponseSchema.safeParse(body);
    if (res.ok && parsed.success) {
      return {
        access: parsed.data.access_token,
        refresh: parsed.data.refresh_token ?? params.refresh_token,
        expiresAt: Date.now() + (parsed.data.expires_in ?? 3600) * 1000,
      };
    }
    const failure = TokenErrorSchema.safeParse(body);
    if (failure.success && res.status >= 400 && res.status < 500) {
      throw new DaymapAuthError(
        `Daymap's identity server refused the ${params.grant_type} grant: ${failure.data.error_description || failure.data.error}`,
      );
    }
    throw new Error(`Daymap's identity server failed the ${params.grant_type} grant (HTTP ${res.status}).`);
  }

  /** Walks the authorise flow in a fresh cookie jar and returns the authorisation code. */
  private async authorize(startUrl: string, state: string, username: string, password: string): Promise<string> {
    const jar = new CookieJar();
    let current = startUrl;
    let form: URLSearchParams | undefined;
    let submittedCredentials = false;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.8" };
      const cookie = await jar.getCookieString(current);
      if (cookie) headers.Cookie = cookie;
      if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
      const res = await fetch(current, {
        method: form ? "POST" : "GET",
        headers,
        body: form?.toString(),
        redirect: "manual",
      });
      for (const setCookie of res.headers.getSetCookie()) {
        await jar.setCookie(setCookie, current, { ignoreError: true }).catch(() => undefined);
      }
      form = undefined;

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, current);
        if (next.toString().split(/[?#]/)[0] === this.redirectUri) {
          return codeFromCallback(next, state);
        }
        current = next.toString();
        continue;
      }

      const body = await res.text();
      const $ = cheerio.load(body);
      const login = $("form")
        .filter((_, el) => $(el).find('input[name="Password"], input[type="password"]').length > 0)
        .first();
      if (login.length === 0) {
        const title = $("title").first().text().trim();
        throw new Error(
          `Daymap sign-in stopped at an unexpected page (HTTP ${res.status}${title ? `, "${title}"` : ""}) at ${current}.`,
        );
      }
      if (submittedCredentials) {
        const message =
          $(".validation-summary-errors, .text-danger, .alert-danger, #spnMsg")
            .text()
            .replace(/\s+/g, " ")
            .trim() || "Daymap rejected the username or password.";
        throw new DaymapAuthError(message);
      }
      form = formFields($, login);
      form.set("Username", username);
      form.set("Password", password);
      form.set("button", "login");
      submittedCredentials = true;
      current = new URL(login.attr("action") || current, current).toString();
    }
    throw new Error("Too many redirects while signing in to Daymap.");
  }
}

/** One signed-in parent's access to their school's family portal API (/lms/api). */
export class DaymapSession {
  constructor(
    private readonly school: DaymapSchool,
    private readonly accessToken: string,
  ) {}

  apiUrl(pathOrUrl: string): URL {
    return this.school.apiUrl(pathOrUrl);
  }

  /** Calls the API as the parent. Writes to payment endpoints are refused. */
  async request(method: HttpMethod, pathOrUrl: string, body?: unknown): Promise<ApiResponse> {
    const url = this.apiUrl(pathOrUrl);
    if (method !== "GET" && isPaymentPath(url.pathname)) {
      throw new Error("Payments can't be changed through this connector.");
    }
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      "X-Daymap-Application-Type": APPLICATION_TYPE,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never follow a redirect with the Bearer token attached.
      redirect: "manual",
    });
    return {
      url: url.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: await res.text(),
    };
  }

  /** Calls the API and parses the JSON response, throwing DaymapApiError on error statuses. */
  async json<T = unknown>(method: HttpMethod, pathOrUrl: string, body?: unknown): Promise<T> {
    const res = await this.request(method, pathOrUrl, body);
    if (res.status < 200 || res.status >= 300) {
      throw new DaymapApiError(describeError(res), res.status, res.body);
    }
    if (!res.body) return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      return res.body as T;
    }
  }
}

function codeFromCallback(callback: URL, state: string): string {
  const params = callback.searchParams;
  const error = params.get("error");
  if (error) {
    throw new DaymapAuthError(params.get("error_description") || error);
  }
  if (params.get("state") !== state) {
    throw new Error("Daymap sign-in returned a mismatched state.");
  }
  const code = params.get("code");
  if (!code) throw new Error("Daymap sign-in didn't return an authorisation code.");
  return code;
}

const DiscoverSchema = z.object({ idserver: z.string().min(1) });
const OpenIdMetadataSchema = z.object({
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
});
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});
const TokenErrorSchema = z.object({ error: z.string(), error_description: z.string().optional() });
const ConsentSchema = z.object({ privacyConsentRequired: z.literal(true) });
const ProblemSchema = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
  message: z.string().optional(),
  Message: z.string().optional(),
});

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}.`);
  return res.json();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeError(res: ApiResponse): string {
  if (res.status === 401) {
    return (
      "Daymap no longer accepts this sign-in (HTTP 401). Disconnect the Daymap connector in Claude's " +
      "settings and connect it again."
    );
  }
  const parsed = parseJson(res.body);
  if (res.status === 403 && ConsentSchema.safeParse(parsed).success) {
    return (
      "Daymap needs you to accept its updated privacy policy before it will share this. Sign in to the " +
      "family portal in a browser, accept the policy, then try again."
    );
  }
  let detail: string;
  if (typeof parsed === "string") {
    detail = parsed;
  } else {
    const problem = ProblemSchema.safeParse(parsed);
    // Server errors put a .NET stack trace in `detail`; keep it only when short and readable.
    const readableDetail =
      problem.success && problem.data.detail && problem.data.detail.length <= 300 && !/\n\s+at /.test(problem.data.detail)
        ? problem.data.detail
        : undefined;
    detail = problem.success
      ? [problem.data.title, problem.data.message ?? problem.data.Message ?? readableDetail]
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .join(": ")
      : res.body.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  return `Daymap returned HTTP ${res.status} for ${res.url}${detail ? ` (${detail})` : ""}.`;
}

function formFields($: cheerio.CheerioAPI, form: cheerio.Cheerio<AnyNode>): URLSearchParams {
  const fields = new URLSearchParams();
  form.find("input[name]").each((_, el) => {
    const input = $(el);
    const type = (input.attr("type") ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image") return;
    if ((type === "checkbox" || type === "radio") && input.attr("checked") === undefined) return;
    fields.append(input.attr("name")!, input.attr("value") ?? "");
  });
  return fields;
}
