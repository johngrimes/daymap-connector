import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DaymapSession, isFormSavePath, isStateChangingGet, type ApiResponse, type HttpMethod } from "./session.js";
import { renderData, truncate } from "./render.js";
import { READ, WRITE, attempt } from "./common.js";
import { registerReadTools } from "./reads.js";
import { registerWriteTools } from "./writes.js";

function renderResponse(res: ApiResponse): string {
  let data: unknown = res.body;
  if (res.contentType.includes("json")) {
    try {
      data = JSON.parse(res.body);
    } catch {
      // Leave as text.
    }
  }
  const body = typeof data === "string" ? truncate(data) : renderData(data);
  return `URL: ${res.url}\nStatus: ${res.status}\n\n${body}`;
}

/** Calls an arbitrary API path; error statuses become tool errors that still show Daymap's reply. */
async function rawCall(session: DaymapSession, method: HttpMethod, path: string, body?: unknown): Promise<string> {
  const res = await session.request(method, path, body);
  const out = renderResponse(res);
  if (res.status >= 400) throw new Error(out);
  return out;
}

/** Creates an MCP server exposing the Daymap tools, backed by the given session. */
export function createServer(session: DaymapSession): McpServer {
  const server = new McpServer({ name: "daymap", version: "0.4.0" });

  registerReadTools(server, session);
  registerWriteTools(server, session);

  server.registerTool(
    "daymap_api_get",
    {
      title: "Call a Daymap API endpoint (read)",
      description:
        "GETs any endpoint of the school's Daymap family portal API (paths under /lms/api/) as the " +
        "logged-in parent and returns the response compactly. For things the dedicated tools don't " +
        "cover, for example: classes and teachers '/lms/api/student/classesbyyear?studentId=ID&year=YYYY&current=1'; " +
        "house points '/lms/api/integrations/points/pointLogForStudent?studentId=ID'; published reports " +
        "'/lms/api/files/filelist?fileType=7&linkId=STUDENT_ID'; a download link for a file " +
        "'/lms/api/files/file/downloadurl/FILE_ID'; term dates '/lms/api/calendars/dateranges/currentandprevious'; " +
        "the school's settings '/lms/api/settings/clientsettings'. Read-only: endpoints that mark things " +
        "read are refused.",
      inputSchema: {
        path: z.string().describe("Path under /lms/api/ (with query string), or a full URL on the school's Daymap host."),
      },
      annotations: READ,
    },
    ({ path }) =>
      attempt(async () => {
        if (isStateChangingGet(session.apiUrl(path).pathname)) {
          throw new Error("That endpoint changes data in Daymap; use daymap_mark_notifications_read instead.");
        }
        return rawCall(session, "GET", path);
      }),
  );

  server.registerTool(
    "daymap_api_request",
    {
      title: "Call a Daymap API endpoint (change something)",
      description:
        "Sends a POST, PUT, PATCH or DELETE to an endpoint of the school's Daymap family portal API " +
        "(paths under /lms/api/) as the logged-in parent, with an optional JSON body. This changes data " +
        "in Daymap: only use it when the user has asked for the change and no dedicated tool fits. " +
        "Payment endpoints (/lms/api/payments/...) are always refused, and forms must be saved with " +
        "daymap_save_form_record.",
      inputSchema: {
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().describe("Path under /lms/api/ (with query string)."),
        body: z.unknown().optional().describe("JSON request body, if the endpoint takes one."),
      },
      annotations: WRITE,
    },
    ({ method, path, body }) =>
      attempt(async () => {
        if (isFormSavePath(session.apiUrl(path).pathname)) {
          throw new Error("Use daymap_save_form_record to save forms; it refuses payment fields.");
        }
        return rawCall(session, method, path, body);
      }),
  );

  return server;
}
