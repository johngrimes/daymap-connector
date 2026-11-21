import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DaymapSchool, DaymapAuthError, DaymapApiError, isPaymentPath, isStateChangingGet } from "../src/session.ts";
import { startMockDaymap, type MockDaymap, type MockState } from "./mock-daymap.ts";

let mock: MockDaymap;
let state: MockState;
let school: DaymapSchool;

before(async () => {
  mock = await startMockDaymap();
  state = mock.state;
  school = new DaymapSchool(mock.base);
});

after(() => mock.close());

beforeEach(() => {
  mock.reset();
  mock.setApi((call, url) => {
    switch (url.pathname) {
      case "/lms/api/contact/studentsforcontact":
        return { body: call.user === "parent" ? [{ ID: 7, Firstname: "Alex" }] : [{ ID: 9, Firstname: "Jo" }] };
      case "/lms/api/forbidden":
        return { status: 403, body: { title: "Forbidden", status: 403 } };
      case "/lms/api/consent":
        return { status: 403, body: { privacyConsentRequired: true } };
      case "/lms/api/crash":
        return {
          status: 500,
          body: { title: "Object reference not set", detail: "System.NullReferenceException\n   at Daymap.Foo()" },
        };
      case "/lms/api/redirect":
        return { status: 302, headers: { Location: "https://elsewhere.invalid/steal" } };
      default:
        return { body: { ok: true, method: call.method } };
    }
  });
});

async function signedIn(username = "parent", password = "secret") {
  return school.session((await school.signIn(username, password)).access);
}

test("signs in with PKCE and calls the API as that parent with their Bearer token", async () => {
  const before = Date.now();
  const tokens = await school.signIn("parent", "secret");
  assert.match(tokens.access, /^at\d+$/);
  assert.match(tokens.refresh!, /^rt\d+$/);
  assert.ok(tokens.expiresAt >= before + 3600_000 && tokens.expiresAt <= Date.now() + 3600_000);
  assert.equal(state.loginPosts, 1);
  assert.equal(state.codeGrants, 1);

  const s = school.session(tokens.access);
  assert.deepEqual(await s.json("GET", "/lms/api/contact/studentsforcontact"), [{ ID: 7, Firstname: "Alex" }]);
  await s.json("GET", "lms/api/anything?x=1");
  assert.equal(state.apiCalls.length, 2);
  for (const call of state.apiCalls) {
    assert.equal(call.auth, `Bearer ${tokens.access}`);
    assert.equal(call.appType, "2");
  }
  assert.equal(state.apiCalls[1].path, "/lms/api/anything?x=1");
});

test("different parents get their own sessions", async () => {
  const [a, b] = await Promise.all([signedIn("parent", "secret"), signedIn("OTHER", "hunter2")]);
  assert.deepEqual(await a.json("GET", "/lms/api/contact/studentsforcontact"), [{ ID: 7, Firstname: "Alex" }]);
  assert.deepEqual(await b.json("GET", "/lms/api/contact/studentsforcontact"), [{ ID: 9, Firstname: "Jo" }]);
  assert.deepEqual(state.apiCalls.map((c) => c.user), ["parent", "other"]);
});

test("a wrong password surfaces Daymap's message as a DaymapAuthError, without retrying", async () => {
  await assert.rejects(school.signIn("parent", "wrong"), (err: unknown) => {
    assert.ok(err instanceof DaymapAuthError);
    assert.match(err.message, /Invalid username and\/or password/);
    return true;
  });
  assert.equal(state.loginPosts, 1);
  assert.equal(state.codeGrants, 0);
});

test("an error from the identity server's callback is a DaymapAuthError", async () => {
  state.callbackError = "Your account is locked.";
  await assert.rejects(school.signIn("parent", "secret"), (err: unknown) => {
    assert.ok(err instanceof DaymapAuthError);
    assert.match(err.message, /Your account is locked/);
    return true;
  });
});

test("a callback with the wrong state is rejected, and isn't blamed on the credentials", async () => {
  state.tamperState = true;
  await assert.rejects(school.signIn("parent", "secret"), (err: unknown) => {
    assert.ok(!(err instanceof DaymapAuthError));
    assert.match((err as Error).message, /mismatched state/);
    return true;
  });
  assert.equal(state.codeGrants, 0);
});

test("refreshing swaps the refresh token for new tokens", async () => {
  const first = await school.signIn("parent", "secret");
  const next = await school.refresh(first.refresh!);
  assert.notEqual(next.access, first.access);
  assert.notEqual(next.refresh, first.refresh);
  assert.equal(state.refreshGrants, 1);
  assert.equal(state.loginPosts, 1);
  assert.deepEqual(await school.session(next.access).json("GET", "/lms/api/contact/studentsforcontact"), [
    { ID: 7, Firstname: "Alex" },
  ]);
});

test("a refused refresh is a DaymapAuthError; an unreachable token endpoint is not", async () => {
  const first = await school.signIn("parent", "secret");
  state.tokenEndpointDown = true;
  await assert.rejects(school.refresh(first.refresh!), (err: unknown) => {
    assert.ok(!(err instanceof DaymapAuthError));
    assert.match((err as Error).message, /HTTP 503/);
    return true;
  });
  state.tokenEndpointDown = false;
  state.refuseRefresh = true;
  await assert.rejects(school.refresh(first.refresh!), (err: unknown) => {
    assert.ok(err instanceof DaymapAuthError);
    assert.match(err.message, /refused the refresh_token grant: expired/);
    return true;
  });
});

test("a revoked token is reported once, with what to do, and not retried", async () => {
  const s = await signedIn();
  state.validTokens.clear();
  await assert.rejects(s.json("GET", "/lms/api/a"), (err: unknown) => {
    assert.ok(err instanceof DaymapApiError);
    assert.equal(err.status, 401);
    assert.match(err.message, /no longer accepts this sign-in.*connect it again/);
    return true;
  });
  assert.equal(state.apiCalls.length, 1);
  assert.equal(state.refreshGrants + state.loginPosts, 1, "only the original sign-in");
});

test("a privacy-policy 403 tells the parent what to do", async () => {
  await assert.rejects((await signedIn()).json("GET", "/lms/api/consent"), /accept its updated privacy policy/);
});

test("server errors report the message without the stack trace", async () => {
  await assert.rejects((await signedIn()).json("GET", "/lms/api/crash"), (err: unknown) => {
    assert.ok(err instanceof DaymapApiError);
    assert.match(err.message, /HTTP 500 .*Object reference not set/);
    assert.doesNotMatch(err.message, /NullReferenceException/);
    return true;
  });
});

test("API errors carry the status and Daymap's problem title", async () => {
  await assert.rejects((await signedIn()).json("GET", "/lms/api/forbidden"), (err: unknown) => {
    assert.ok(err instanceof DaymapApiError);
    assert.equal(err.status, 403);
    assert.match(err.message, /HTTP 403 .*Forbidden/);
    return true;
  });
});

test("redirects from the API are not followed with the token", async () => {
  const res = await (await signedIn()).request("GET", "/lms/api/redirect");
  assert.equal(res.status, 302);
});

test("writes send a JSON body", async () => {
  await (await signedIn()).json("PATCH", "/lms/api/coms/message/read", { MessageIds: [1], Read: true });
  const call = state.apiCalls.at(-1)!;
  assert.equal(call.method, "PATCH");
  assert.deepEqual(JSON.parse(call.body), { MessageIds: [1], Read: true });
});

test("payment endpoints can be read but never written, however the path is spelt", async () => {
  const s = await signedIn();
  assert.deepEqual(await s.json("GET", "/lms/api/payments/list?from=a&to=b"), { ok: true, method: "GET" });
  const before = state.apiCalls.length;
  for (const path of [
    "/lms/api/payments/charge",
    "/LMS/API/Payments/charge",
    "/lms/api//payments/charge",
    "/lms/api/payments%2Fcharge",
    "/lms/api/%70ayments/charge",
    "/lms/api/coms/../payments/charge",
    "/lms/api/coms/%2e%2e/payments/charge",
    "/lms/api/payments",
    "/lms/api/payments?x=1",
    "/lms/api/x/..%2fpayments/charge",
    "/lms/api/x/..%5Cpayments/charge",
    "/lms/api/x/%2E%2E%2Fpayments/charge",
    "/lms/api/x/%252e%252e%252fpayments/charge",
    "/lms/api/x/./../payments/charge",
  ]) {
    await assert.rejects(s.request("POST", path, {}), /Payments can't be changed/, path);
  }
  assert.equal(state.apiCalls.length, before, "nothing was sent");
  assert.equal(isPaymentPath("/lms/api/paymentsettings"), false);
});

test("notification mark-read GETs are recognised as state-changing", () => {
  for (const path of [
    "/lms/api/coms/notifications/setread",
    "/lms/api/coms/notifications/setread/5",
    "/LMS/api/coms//notifications/SetRead/5",
    "/lms/api/coms/notifications/announcementread",
    "/lms/api/coms/alerts",
    "/lms/api/x/..%2fcoms/notifications/setread",
    "/lms/api/x/..%5ccoms%5cnotifications%5csetread/3",
  ]) {
    assert.equal(isStateChangingGet(path), true, path);
  }
  assert.equal(isStateChangingGet("/lms/api/coms/notifications"), false);
});

test("only /lms/api on the school's own host can be called", async () => {
  const s = school.session("at-unused");
  await assert.rejects(s.request("GET", "https://elsewhere.invalid/lms/api/x"), /only http:\/\/127\.0\.0\.1/);
  await assert.rejects(s.request("GET", "/portals/family/"), /under \/lms\/api\//);
  await assert.rejects(s.request("GET", "/lms/api/../daymap/x"), /under \/lms\/api\//);
  await assert.rejects(s.request("GET", "/lms/api/..%2f..%2fdaymap/x"), /under \/lms\/api\//);
  await assert.rejects(s.request("GET", "/lms/api/x/..%5C..%5Cdaymap/x"), /under \/lms\/api\//);
  assert.equal(state.apiCalls.length, 0);
});

test("paths with malformed or deeply nested escapes are refused before anything is sent", async () => {
  const s = school.session("at-unused");
  for (const [method, path] of [
    ["DELETE", "/lms/api/%70ayments/customer/%zz%2f.."],
    ["POST", "/lms/api/%70ayments/charge/%c0"],
    ["POST", "/lms/api/%66orms/record/save/%u0041%2f.."],
    ["GET", "/lms/api/coms/notifications/%73etread/5/%zz%2f.."],
    ["GET", "/lms/api/%zz%2f..%2f..%2f..%2fdaymap/dws/discover.ashx"],
    ["GET", "/lms/api/%2525252525252e"],
  ] as const) {
    await assert.rejects(s.request(method, path), /malformed or nested percent-encoding/, path);
  }
  assert.equal(state.apiCalls.length, 0, "nothing was sent");
  assert.equal(isPaymentPath("/lms/api/%70ayments/charge/%zz"), true, "undecodable paths count as blocked");
});
