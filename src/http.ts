#!/usr/bin/env node
import express from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { DaymapAuthProvider, daymapAccessToken } from "./auth.js";
import { createServer } from "./tools.js";
import { DaymapSchool } from "./session.js";

export interface HttpOptions {
  /** Public HTTPS address of this server, e.g. https://daymap.example.com */
  publicUrl: URL;
  provider: DaymapAuthProvider;
  school: DaymapSchool;
  /** Number of reverse proxies in front of the server (for client IPs in rate limiting). */
  trustProxy?: number | boolean;
}

/**
 * Hosted (remote) entry point: MCP over Streamable HTTP at /mcp, protected by OAuth.
 * Add `${PUBLIC_URL}/mcp` as a custom connector in Claude.
 */
export function createApp({ publicUrl, provider, school, trustProxy = 1 }: HttpOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  const mcpUrl = new URL("/mcp", publicUrl);

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: `${provider.title} connector`,
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  app.post(
    "/login",
    // Ten failed attempts per IP per 15 minutes; signing in successfully doesn't count.
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      skipSuccessfulRequests: true,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Frame-Options", "DENY");
      const result = await provider.completeLogin(
        String(req.body?.pending ?? ""),
        String(req.body?.username ?? ""),
        String(req.body?.password ?? ""),
      );
      if ("redirect" in result) {
        res.redirect(302, result.redirect);
      } else {
        res.status(result.status).type("html").send(result.html);
      }
    },
  );

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // Stateless Streamable HTTP: a fresh MCP server per request, acting as the parent who signed in.
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const server = createServer(school.session(daymapAccessToken(req.auth!)));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  };
  app.get("/mcp", bearer, methodNotAllowed);
  app.delete("/mcp", bearer, methodNotAllowed);

  return app;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}.`);
    process.exit(1);
  }
  return value;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const publicUrl = new URL(required("PUBLIC_URL"));
  const school = new DaymapSchool(required("DAYMAP_URL"));
  const provider = new DaymapAuthProvider({
    school,
    allowedUsers: required("ALLOWED_DAYMAP_USERS").split(","),
    signingSecret: required("TOKEN_SIGNING_SECRET"),
    allowedRedirectUris: process.env.OAUTH_ALLOWED_REDIRECT_URIS?.split(",").map((s) => s.trim()).filter(Boolean),
    title: process.env.CONNECTOR_TITLE,
  });
  const trustProxyEnv = process.env.TRUST_PROXY;
  const app = createApp({
    publicUrl,
    provider,
    school,
    trustProxy: trustProxyEnv === undefined ? 1 : /^\d+$/.test(trustProxyEnv) ? Number(trustProxyEnv) : trustProxyEnv === "true",
  });
  const port = Number(process.env.PORT || 3000);
  const httpServer = app.listen(port, () => {
    console.log(`Daymap connector listening on :${port}; connector URL ${new URL("/mcp", publicUrl)}`);
  });
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
