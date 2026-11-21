import { z } from "zod";
import type { DaymapSession } from "./session.js";

export interface Student {
  ID: number;
  ContactID?: number;
  Firstname?: string;
  Surname?: string;
  Displayname?: string;
  DisplaynameSurname?: string;
  GivenName?: string;
}

const optionalText = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

const StudentListSchema = z.array(
  z.looseObject({
    ID: z.number(),
    ContactID: z.number().nullish().transform((v) => v ?? undefined),
    Firstname: optionalText,
    Surname: optionalText,
    Displayname: optionalText,
    DisplaynameSurname: optionalText,
    GivenName: optionalText,
  }),
);

export function studentName(s: Student): string {
  return s.DisplaynameSurname || [s.Firstname, s.Surname].filter(Boolean).join(" ") || `student ${s.ID}`;
}

/** The students (children) linked to the signed-in parent. */
export async function listStudents(session: DaymapSession): Promise<Student[]> {
  return StudentListSchema.parse(await session.json("GET", "/lms/api/contact/studentsforcontact"));
}

/**
 * Picks the student a tool call is about: by ID or (part of a) name, or the only
 * child on the account when none is given.
 */
export async function resolveStudent(session: DaymapSession, student?: string): Promise<Student> {
  const students = await listStudents(session);
  if (students.length === 0) throw new Error("This Daymap account has no students linked to it.");
  const describe = (list: Student[]) => list.map((s) => `${studentName(s)} (ID ${s.ID})`).join(", ");
  const wanted = student?.trim();
  if (!wanted) {
    if (students.length === 1) return students[0];
    throw new Error(`This account has more than one student; say which one: ${describe(students)}.`);
  }
  if (/^\d+$/.test(wanted)) {
    const byId = students.find((s) => s.ID === Number(wanted));
    if (byId) return byId;
  }
  const needle = wanted.toLowerCase();
  const matches = students.filter((s) =>
    [s.Firstname, s.Surname, s.Displayname, s.DisplaynameSurname, s.GivenName, studentName(s)].some((n) =>
      n?.toLowerCase().includes(needle),
    ),
  );
  if (matches.length === 1) return matches[0];
  throw new Error(
    matches.length === 0
      ? `No student matches "${wanted}". Students on this account: ${describe(students)}.`
      : `"${wanted}" matches more than one student: ${describe(matches)}.`,
  );
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Runs a tool body, turning thrown errors into MCP tool errors. */
export async function attempt(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

export const READ = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const studentArg = z
  .string()
  .optional()
  .describe("Student name or ID. Leave out when the account has only one student.");

/** A calendar date as Daymap's date parameters expect it. */
export const dateArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a real date.");

export const idArg = z.number().int().positive();

/** The school's settings, which say which messaging features parents may use. */
const ClientSettingsSchema = z.looseObject({
  Messaging: z
    .looseObject({
      ParentsAbsenceMessage: z.boolean().optional(),
      ParentsSchoolMessage: z.boolean().optional(),
      ParentsToStaff: z.boolean().optional(),
      StudentParentMessage: z.boolean().optional(),
    })
    .optional(),
  interviewAlertNotificationSendVia: z.number().optional(),
});

export type ClientSettings = z.infer<typeof ClientSettingsSchema>;

export async function clientSettings(session: DaymapSession): Promise<ClientSettings> {
  return ClientSettingsSchema.parse(await session.json("GET", "/lms/api/settings/clientsettings"));
}

/** Builds a query string, leaving out undefined values. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
