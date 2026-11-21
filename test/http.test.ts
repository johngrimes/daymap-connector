import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Response } from "express";
import { createApp } from "../src/http.ts";
import { DaymapAuthProvider } from "../src/auth.ts";
import { DaymapSchool } from "../src/session.ts";
import { startMockDaymap, type MockDaymap } from "./mock-daymap.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const SECRET = "x".repeat(40);
let mock: MockDaymap;
let school: DaymapSchool;
const servers: Server[] = [];
let base: string;

/** Serves the connector with the given allowlist (and the shared signing secret), returning its base URL. */
async function serve(allowedUsers: string[]): Promise<string> {
  const provider = new DaymapAuthProvider({ school, allowedUsers, signingSecret: SECRET });
  // The issuer must be HTTPS unless it's localhost; listen first, then build the app.
  const listening = Promise.withResolvers<void>();
  const server = createApp({ publicUrl: new URL("http://localhost"), provider, school }).listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  servers.push(server);
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  server.removeAllListeners("request");
  server.on("request", createApp({ publicUrl: new URL(url), provider, school }));
  return url;
}

before(async () => {
  mock = await startMockDaymap();
  school = new DaymapSchool(mock.base);
  base = await serve(["Parent", " other "]);
});

after(() => {
  for (const s of servers) s.close();
  mock.close();
});

beforeEach(() => {
  mock.reset();
  mock.setApi((call, url) => {
    switch (url.pathname) {
      case "/lms/api/contact/user":
        return { body: { Username: call.user } };
      case "/lms/api/contact/studentsforcontact":
        return { body: [{ ID: call.user === "parent" ? 7 : 9, Firstname: call.user === "parent" ? "Alex" : "Jo" }] };
    }
  });
});

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

async function register(body: object, at = base) {
  return fetch(`${at}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function startAuthorize(clientId: string, challenge: string, at = base) {
  const url = new URL(`${at}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 200);
  const html = await res.text();
  return { html, pending: html.match(/name="pending" value="([^"]+)"/)![1] };
}

function login(pending: string, username: string, password: string, at = base) {
  return fetch(`${at}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending, username, password }),
    redirect: "manual",
  });
}

function token(params: Record<string, string>, at = base) {
  return fetch(`${at}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

function mcp(accessToken: string | undefined, method = "tools/list", params: object = {}, at = base) {
  return fetch(`${at}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** Calls daymap_students and returns the text it rendered. */
async function students(accessToken: string, at = base) {
  const res = await mcp(accessToken, "tools/call", { name: "daymap_students", arguments: {} }, at);
  assert.equal(res.status, 200);
  return res.text();
}

/** Registers a public client and signs in, returning the client and Claude's tokens. */
async function connect(username: string, password: string, at = base) {
  const client = await (await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }, at)).json();
  const { verifier, challenge } = pkce();
  const signedIn = await login((await startAuthorize(client.client_id, challenge, at)).pending, username, password, at);
  assert.equal(signedIn.status, 302, await signedIn.clone().text());
  const code = new URL(signedIn.headers.get("location")!).searchParams.get("code")!;
  const res = await token(
    { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT },
    at,
  );
  assert.equal(res.status, 200);
  return { client, tokens: await res.json() };
}

test("publishes OAuth metadata and challenges unauthenticated MCP requests", async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.registration_endpoint, `${base}/register`);
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  const res = await mcp(undefined);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("rejects registration with a redirect URI that isn't Claude's", async () => {
  const res = await register({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" });
  assert.equal(res.status, 400);
});

test("full flow: sign in with Daymap credentials, exchange code, act as the parent, refresh", async () => {
  const client = await (await register({
    client_name: "Claude",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
  })).json();
  assert.ok(client.client_id && client.client_secret);

  const { verifier, challenge } = pkce();
  const { html, pending } = await startAuthorize(client.client_id, challenge);
  assert.match(html, /name="username"/);
  assert.match(html, /name="password" type="password"/);
  assert.match(html, /Claude wants to use your Daymap/);

  const wrong = await login(pending, "parent", "nope");
  assert.equal(wrong.status, 400);
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /Invalid username and\/or password/);
  assert.match(wrongHtml, /name="username"[^>]*value="parent"/, "the username is kept");
  assert.equal(mock.state.loginPosts, 1);

  const ok = await login(pending, "parent", "secret");
  assert.equal(ok.status, 302);
  const redirect = new URL(ok.headers.get("location")!);
  assert.equal(redirect.origin + redirect.pathname, REDIRECT);
  assert.equal(redirect.searchParams.get("state"), "xyz");
  const code = redirect.searchParams.get("code")!;
  assert.doesNotMatch(Buffer.from(code, "base64url").toString("latin1"), /"typ"|rt\d/, "the code is encrypted");

  const badVerifier = await token({
    grant_type: "authorization_code", code, code_verifier: "wrong".repeat(10),
    client_id: client.client_id, client_secret: client.client_secret, redirect_uri: REDIRECT,
  });
  assert.equal(badVerifier.status, 400);

  const tokRes = await token({
    grant_type: "authorization_code", code, code_verifier: verifier,
    client_id: client.client_id, client_secret: client.client_secret, redirect_uri: REDIRECT,
  });
  assert.equal(tokRes.status, 200);
  const tokens = await tokRes.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.ok(tokens.expires_in > 3400 && tokens.expires_in <= 3540, `expires_in ${tokens.expires_in}`);

  const replay = await token({
    grant_type: "authorization_code", code, code_verifier: verifier,
    client_id: client.client_id, client_secret: client.client_secret, redirect_uri: REDIRECT,
  });
  assert.equal(replay.status, 400, "codes can only be used once");

  const list = await mcp(tokens.access_token);
  assert.equal(list.status, 200);
  const text = await list.text();
  for (const name of ["daymap_students", "daymap_api_get", "daymap_api_request"]) assert.match(text, new RegExp(name));

  assert.match(await students(tokens.access_token), /Alex/);
  const firstDaymapToken = mock.state.apiCalls.at(-1)!.auth;
  assert.equal(mock.state.apiCalls.at(-1)!.user, "parent");

  const refreshed = await token({
    grant_type: "refresh_token", refresh_token: tokens.refresh_token,
    client_id: client.client_id, client_secret: client.client_secret,
  });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.equal(mock.state.refreshGrants, 1, "refreshing Claude's token refreshes Daymap's");
  assert.match(await students(next.access_token), /Alex/);
  assert.notEqual(mock.state.apiCalls.at(-1)!.auth, firstDaymapToken, "the new Daymap token is used");

  const reused = await token({
    grant_type: "refresh_token", refresh_token: tokens.refresh_token,
    client_id: client.client_id, client_secret: client.client_secret,
  });
  assert.equal(reused.status, 400, "Daymap's refresh tokens are single-use");
  assert.equal((await reused.json()).error, "invalid_grant");

  assert.equal((await mcp(tokens.access_token + "x")).status, 401);
  assert.equal((await mcp(tokens.refresh_token)).status, 401, "a refresh token isn't an access token");
});

test("each parent acts as themselves", async () => {
  const parent = await connect("parent", "secret");
  const other = await connect("Other", "hunter2");
  assert.match(await students(parent.tokens.access_token), /Alex/);
  assert.match(await students(other.tokens.access_token), /Jo/);
  assert.deepEqual(mock.state.apiCalls.map((c) => c.user), ["parent", "parent", "other", "other"]);
});

test("a username that isn't allowed is refused before anything is sent to Daymap", async () => {
  const client = await (await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" })).json();
  const { pending } = await startAuthorize(client.client_id, pkce().challenge);
  const res = await login(pending, "outsider", "letmein");
  assert.equal(res.status, 403);
  assert.match(await res.text(), /isn&#39;t allowed to use this connector/);
  const blank = await login(pending, "  ", "x");
  assert.equal(blank.status, 400);
  assert.match(await blank.text(), /Enter your Daymap username and password/);
  assert.equal(mock.state.loginPosts, 0);
});

test("allowed usernames match ignoring case and surrounding spaces", async () => {
  const { tokens } = await connect(" PARENT ", "secret");
  assert.match(await students(tokens.access_token), /Alex/);
});

test("Claude's access token expires just before Daymap's", async () => {
  mock.state.expiresIn = 600;
  assert.ok((await connect("parent", "secret")).tokens.expires_in <= 540);
  mock.state.expiresIn = 30;
  const { expires_in } = (await connect("parent", "secret")).tokens;
  assert.ok(expires_in > 0 && expires_in <= 15, `expires_in ${expires_in}`);
});

test("when Daymap refuses the refresh, Claude is told to reconnect; when it's down, to retry", async () => {
  const { client, tokens } = await connect("parent", "secret");
  const refresh = () =>
    token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });

  mock.state.tokenEndpointDown = true;
  const down = await refresh();
  assert.equal(down.status, 500);
  assert.equal((await down.json()).error, "server_error");

  mock.state.tokenEndpointDown = false;
  mock.state.refuseRefresh = true;
  const refused = await refresh();
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "invalid_grant");
});

test("taking a parent off the allowlist cuts off their existing tokens", async () => {
  const { client, tokens } = await connect("parent", "secret");
  const narrower = await serve(["other"]);
  assert.equal((await mcp(tokens.access_token, "tools/list", {}, narrower)).status, 401);
  const res = await token(
    { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id },
    narrower,
  );
  assert.equal(res.status, 400);
  assert.equal(mock.state.refreshGrants, 0, "Daymap isn't asked");
  assert.equal((await mcp(tokens.access_token)).status, 200, "still fine where they're allowed");
});

test("public clients (no secret) work too", async () => {
  const { client, tokens } = await connect("parent", "secret");
  assert.equal(client.client_secret, undefined);
  assert.ok(tokens.access_token);
});

test("a tampered client ID is rejected", async () => {
  const res = await fetch(`${base}/authorize?response_type=code&client_id=abc.def&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=x&code_challenge_method=S256`, { redirect: "manual" });
  assert.equal(res.status, 400);
});

test("an unreachable Daymap gives a retry message, not a credentials error", async () => {
  const provider = new DaymapAuthProvider({
    school: new DaymapSchool("http://127.0.0.1:1"),
    allowedUsers: ["parent"],
    signingSecret: SECRET,
  });
  let page = "";
  const res = { setHeader() {}, status() { return this; }, type() { return this; }, send(html: string) { page = html; } };
  await provider.authorize(
    { client_id: "c", redirect_uris: [REDIRECT] },
    { redirectUri: REDIRECT, codeChallenge: "x" },
    res as unknown as Response,
  );
  const pending = page.match(/name="pending" value="([^"]+)"/)![1];
  const result = await provider.completeLogin(pending, "parent", "secret");
  assert.ok("html" in result);
  assert.equal(result.status, 502);
  assert.match(result.html, /Couldn&#39;t sign in to Daymap just now/);
});

test("the allowlist is required", () => {
  assert.throws(() => new DaymapAuthProvider({ school, allowedUsers: [" ", ""], signingSecret: SECRET }), /At least one/);
});

test("only failed sign-ins count towards the rate limit", async () => {
  const fresh = await serve(["parent"]);
  for (let i = 0; i < 12; i++) await connect("parent", "secret", fresh);
  const client = await (await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }, fresh)).json();
  const { pending } = await startAuthorize(client.client_id, pkce().challenge, fresh);
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await login(pending, "parent", "wrong", fresh)).status);
  assert.deepEqual(statuses, [...Array(10).fill(400), 429]);
});
