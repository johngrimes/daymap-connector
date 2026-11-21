import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

export interface ApiCall {
  method: string;
  /** Path plus query string, as received. */
  path: string;
  auth?: string;
  /** The account the Bearer token belongs to, if it's valid. */
  user?: string;
  appType?: string;
  body: string;
}

export interface ApiReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Answers an authorised /lms/api request; undefined means 404. */
export type ApiHandler = (call: ApiCall, url: URL) => ApiReply | undefined;

export interface MockState {
  loginPosts: number;
  codeGrants: number;
  refreshGrants: number;
  expiresIn: number;
  refuseRefresh: boolean;
  /** Makes the token endpoint answer 503 with no OAuth error body. */
  tokenEndpointDown: boolean;
  callbackError: string;
  tamperState: boolean;
  /** Valid access tokens and the account each belongs to. */
  validTokens: Map<string, string>;
  apiCalls: ApiCall[];
}

export interface MockDaymap {
  base: string;
  state: MockState;
  /** Replaces the /lms/api handler. */
  setApi(handler: ApiHandler): void;
  reset(): void;
  close(): void;
}

const freshState = (): Omit<MockState, "validTokens"> => ({
  loginPosts: 0,
  codeGrants: 0,
  refreshGrants: 0,
  expiresIn: 3600,
  refuseRefresh: false,
  tokenEndpointDown: false,
  callbackError: "",
  tamperState: false,
  apiCalls: [],
});

/** Daymap accounts (usernames are case-insensitive, as on Daymap) and their passwords. */
export const ACCOUNTS: Record<string, string> = { parent: "secret", other: "hunter2", outsider: "letmein" };

function readBody(req: http.IncomingMessage): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => resolve(data));
  return promise;
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function loginPage(returnUrl: string, error: string) {
  return `<html><head><title>Daymap Login</title></head><body><form action="" method="post">
    <input type="hidden" name="ReturnUrl" value="${returnUrl.replace(/&/g, "&amp;")}" />
    <input name="Username" type="text" value="" />
    <input name="Password" type="password" />
    <div class="validation-summary-errors">${error}</div>
    <button name="button" value="login">Sign In</button>
    <input name="__RequestVerificationToken" type="hidden" value="csrf" /></form></body></html>`;
}

/**
 * Starts a mock of a Daymap school site and its identity server (both on one server,
 * the identity server under /identity): discovery, OpenID metadata, authorise → login
 * form (any of ACCOUNTS) → redirect to /portals/family/auth with a code, the token
 * endpoint (refresh tokens are single-use, as with IdentityServer's default), and
 * /lms/api endpoints that require a Bearer token.
 */
export async function startMockDaymap(): Promise<MockDaymap> {
  const state: MockState = { ...freshState(), validTokens: new Map() };
  const pendingCodes = new Map<string, { challenge: string; redirectUri: string; user: string }>();
  const refreshTokens = new Map<string, string>();
  let tokenCounter = 0;
  let api: ApiHandler = () => undefined;
  let base = "";

  const issueTokens = (res: http.ServerResponse, user: string) => {
    const n = ++tokenCounter;
    state.validTokens.set(`at${n}`, user);
    refreshTokens.set(`rt${n}`, user);
    json(res, 200, { access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: state.expiresIn, token_type: "Bearer" });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const path = url.pathname;

    if (path === "/daymap/dws/discover.ashx") {
      return json(res, 200, { schoolcode: "TEST", idserver: `${base}/identity/` });
    }
    if (path === "/identity/.well-known/openid-configuration") {
      return json(res, 200, {
        authorization_endpoint: `${base}/identity/connect/authorize`,
        token_endpoint: `${base}/identity/connect/token`,
      });
    }
    if (path === "/identity/connect/authorize") {
      assert.equal(url.searchParams.get("client_id"), "Connect.API");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("redirect_uri"), `${base}/portals/family/auth`);
      res.writeHead(302, {
        Location: `/identity/Account/Login?ReturnUrl=${encodeURIComponent(`/identity/connect/authorize/callback?${url.searchParams}`)}`,
      });
      return res.end();
    }
    if (path === "/identity/Account/Login") {
      if (req.method === "POST") {
        state.loginPosts++;
        const form = new URLSearchParams(await readBody(req));
        assert.equal(form.get("__RequestVerificationToken"), "csrf");
        const user = (form.get("Username") ?? "").toLowerCase();
        if (ACCOUNTS[user] !== undefined && ACCOUNTS[user] === form.get("Password")) {
          res.writeHead(302, { "Set-Cookie": `idsrv=${user}; path=/identity`, Location: form.get("ReturnUrl")! });
          return res.end();
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(loginPage(form.get("ReturnUrl")!, "Invalid username and/or password."));
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(loginPage(url.searchParams.get("ReturnUrl")!, ""));
    }
    if (path === "/identity/connect/authorize/callback") {
      const user = /idsrv=([a-z]+)/.exec(req.headers.cookie ?? "")?.[1];
      assert.ok(user, "signed in");
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      if (state.callbackError) {
        redirect.search = new URLSearchParams({ error: "access_denied", error_description: state.callbackError }).toString();
      } else {
        const code = `code${Math.random()}`;
        pendingCodes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirectUri: redirect.toString(), user });
        redirect.search = new URLSearchParams({
          code,
          state: state.tamperState ? "other" : url.searchParams.get("state")!,
        }).toString();
      }
      res.writeHead(302, { Location: redirect.toString() });
      return res.end();
    }
    if (path === "/identity/connect/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      assert.equal(form.get("client_id"), "Connect.API");
      if (state.tokenEndpointDown) {
        res.writeHead(503, { "Content-Type": "text/html" });
        return res.end("<h1>Service Unavailable</h1>");
      }
      if (form.get("grant_type") === "authorization_code") {
        state.codeGrants++;
        const pending = pendingCodes.get(form.get("code")!);
        pendingCodes.delete(form.get("code")!);
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!pending || pending.challenge !== challenge || pending.redirectUri !== form.get("redirect_uri")) {
          return json(res, 400, { error: "invalid_grant" });
        }
        return issueTokens(res, pending.user);
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshGrants++;
        const user = refreshTokens.get(form.get("refresh_token")!);
        refreshTokens.delete(form.get("refresh_token")!);
        if (state.refuseRefresh || !user) return json(res, 400, { error: "invalid_grant", error_description: "expired" });
        return issueTokens(res, user);
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (path.startsWith("/lms/api/")) {
      const call: ApiCall = {
        method: req.method!,
        path: path + url.search,
        auth: req.headers.authorization,
        appType: req.headers["x-daymap-application-type"] as string | undefined,
        body: await readBody(req),
      };
      call.user = call.auth?.startsWith("Bearer ") ? state.validTokens.get(call.auth.slice(7)) : undefined;
      state.apiCalls.push(call);
      if (!call.user) {
        return json(res, 401, { title: "Unauthorized", status: 401 });
      }
      const reply = api(call, url);
      if (!reply) return json(res, 404, { title: "Not Found", status: 404 });
      return json(res, reply.status ?? 200, reply.body, reply.headers);
    }
    res.writeHead(404);
    res.end();
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    state,
    setApi(handler) {
      api = handler;
    },
    reset() {
      Object.assign(state, freshState());
      api = () => undefined;
    },
    close() {
      server.close();
    },
  };
}
