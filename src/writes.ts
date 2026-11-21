import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaymapSession } from "./session.js";
import { renderData } from "./render.js";
import { WRITE, attempt, clientSettings, dateArg, idArg, query, resolveStudent, studentArg } from "./common.js";

/** Bits of a message thread's actionMask (Daymap's MessageActions). */
const ACTION_REPLY_ALL = 2;
const ACTION_REPLY = 512;

/** Daymap message types a parent can create. */
const MESSAGE_TYPE = { school: 5, absence: 6, person: 10 } as const;

/** Form control types (Daymap's ControlType) that need special handling when saving. */
const CONTROL = { datePicker: 4, checkbox: 6, paymentFieldOld: 20, dateAndTimePicker: 21, paymentField: 23, timePicker: 26 };

const messageIdsArg = z.array(idArg).min(1).max(100).describe("MessageIDs.");

const ThreadSchema = z.looseObject({
  actionMask: z.number().default(0),
  messages: z.array(z.looseObject({ ThreadID: z.number() })).min(1),
});

const DraftSchema = z.looseObject({ MessageID: z.number(), ThreadID: z.number(), MessageType: z.number() });

const ContactListSchema = z.array(
  z.looseObject({
    Student: z.looseObject({ ContactID: z.number() }).nullish(),
    CanMessageStudent: z.boolean().optional(),
    Teachers: z.array(z.looseObject({ ContactID: z.number() })).nullish(),
    Leaders: z.array(z.looseObject({ ContactID: z.number() })).nullish(),
  }),
);

const FormRecordSchema = z.looseObject({
  Form: z.looseObject({
    Items: z.array(
      z.looseObject({
        FieldID: z.number(),
        Caption: z.string().nullish(),
        ControlType: z.number().nullish(),
      }),
    ),
  }),
  Record: z
    .looseObject({
      CanEdit: z.boolean().nullish(),
      Results: z.record(z.string(), z.looseObject({ Value: z.unknown() }).nullish()).nullish(),
    })
    .nullish(),
});

const ExcursionSchema = z.looseObject({
  ProjectId: z.number().nullish(),
  ConsentStatus: z.number().nullish(),
  ConsentRequired: z.boolean().nullish(),
  ConsentExpiryPassed: z.boolean().nullish(),
});

const InterviewGroupSchema = z.looseObject({ ParentOptions: z.array(z.string()).nullish() });

/** Creates a draft message and sends it, as the portal does. */
async function createAndSend(session: DaymapSession, draft: Record<string, unknown>): Promise<string> {
  const created = DraftSchema.parse(await session.json("POST", "/lms/api/coms/message/create", draft));
  const sent = await session.json("POST", "/lms/api/coms/draft/send", {
    ThreadID: created.ThreadID,
    MessageID: created.MessageID,
    MessageType: created.MessageType,
  });
  return `Sent.\n\n${renderData(sent)}`;
}

/** Formats a form value the way the portal sends it: dates as is, everything else URL-encoded. */
function formValue(controlType: number | null | undefined, value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "boolean" ? (value ? "True" : "False") : String(value);
  if (controlType === CONTROL.datePicker) return dateOrEmpty(text, 10);
  if (controlType === CONTROL.dateAndTimePicker || controlType === CONTROL.timePicker) return dateOrEmpty(text, 16);
  return encodeURIComponent(text);
}

/** Cuts an ISO date(time) to YYYY-MM-DD (10) or YYYY-MM-DDTHH:mm (16); anything unparseable becomes empty, as in the portal. */
function dateOrEmpty(text: string, length: 10 | 16): string {
  return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/.test(text) && !Number.isNaN(Date.parse(text.slice(0, 10)))
    ? text.slice(0, length)
    : "";
}

export function registerWriteTools(server: McpServer, session: DaymapSession): void {
  server.registerTool(
    "daymap_mark_messages_read",
    {
      title: "Mark messages read or unread",
      description: "Marks Daymap messages (MessageIDs from daymap_messages) as read, or as unread with read=false.",
      inputSchema: {
        message_ids: messageIdsArg,
        read: z.boolean().default(true).describe("true = mark read (default), false = mark unread."),
      },
      annotations: WRITE,
    },
    ({ message_ids, read }) =>
      attempt(async () => {
        await session.json("PATCH", "/lms/api/coms/message/read", { MessageIds: message_ids, Read: read });
        return `Marked ${message_ids.length} message(s) ${read ? "read" : "unread"}.`;
      }),
  );

  server.registerTool(
    "daymap_archive_messages",
    {
      title: "Archive or restore messages",
      description:
        "Moves Daymap messages (MessageIDs) to the Archived folder. The portal uses the same action to " +
        "restore messages that are already archived, so archived messages go back to their folder.",
      inputSchema: { message_ids: messageIdsArg },
      annotations: WRITE,
    },
    ({ message_ids }) =>
      attempt(async () => {
        await session.json("PATCH", "/lms/api/coms/message/archive", message_ids);
        return `Archived (or restored) ${message_ids.length} message(s).`;
      }),
  );

  server.registerTool(
    "daymap_mark_notifications_read",
    {
      title: "Mark notifications read",
      description:
        "Marks a notification (a NotificationID from daymap_notifications) as read, or every notification " +
        "when notification_id is left out.",
      inputSchema: { notification_id: idArg.optional().describe("NotificationID; leave out for all.") },
      annotations: WRITE,
    },
    ({ notification_id }) =>
      attempt(async () => {
        // Daymap marks notifications read with a GET.
        await session.json(
          "GET",
          `/lms/api/coms/notifications/setread${notification_id === undefined ? "" : `/${notification_id}`}`,
        );
        return notification_id === undefined ? "Marked all notifications read." : "Marked the notification read.";
      }),
  );

  server.registerTool(
    "daymap_reply_to_message",
    {
      title: "Reply to a message",
      description:
        "Sends a reply in an existing Daymap message thread (a MessageID from daymap_messages or " +
        "daymap_message_thread). Only works where the thread allows replies. The reply goes to the sender, " +
        "or to everyone on the thread with reply_all.",
      inputSchema: {
        message_id: idArg.describe("MessageID of any message in the thread."),
        body: z.string().trim().min(1).max(20_000).describe("Reply text (plain text)."),
        reply_all: z.boolean().default(false).describe("Reply to everyone on the thread."),
      },
      annotations: WRITE,
    },
    ({ message_id, body, reply_all }) =>
      attempt(async () => {
        const thread = ThreadSchema.parse(await session.json("GET", `/lms/api/coms/message/${message_id}/thread`));
        const needed = reply_all ? ACTION_REPLY_ALL : ACTION_REPLY;
        if ((thread.actionMask & needed) === 0) {
          throw new Error(`Daymap doesn't allow ${reply_all ? "reply-all" : "replies"} on this message.`);
        }
        return createAndSend(session, { body, threadID: thread.messages[0].ThreadID, replyAll: reply_all });
      }),
  );

  server.registerTool(
    "daymap_send_message",
    {
      title: "Send a new message",
      description:
        "Sends a new Daymap message from the parent. kind = 'absence' notifies the school that a student " +
        "is or was absent (needs absence_date; optional reason code); 'school' writes to the school office; " +
        "'person' writes to teachers or the parent's child (contact_ids from daymap_message_recipients). " +
        "Schools switch these on and off; daymap_message_recipients says which are allowed.",
      inputSchema: {
        kind: z.enum(["absence", "school", "person"]),
        body: z.string().trim().min(1).max(20_000).describe("Message text (plain text)."),
        students: z
          .array(z.string())
          .optional()
          .describe("absence: the absent students' names or IDs (default the only student)."),
        absence_date: dateArg.optional().describe("absence: date of the absence (YYYY-MM-DD)."),
        absence_reason: z.string().optional().describe("absence: reason code, if the school uses them."),
        contact_ids: z.array(idArg).min(1).optional().describe("person: recipients' ContactIDs."),
      },
      annotations: WRITE,
    },
    ({ kind, body, students, absence_date, absence_reason, contact_ids }) =>
      attempt(async () => {
        const messaging = (await clientSettings(session)).Messaging ?? {};
        if (kind === "absence") {
          if (!messaging.ParentsAbsenceMessage) throw new Error("This school doesn't accept absence notifications through Daymap.");
          if (!absence_date) throw new Error("An absence notification needs absence_date.");
          const absent = await Promise.all((students?.length ? students : [undefined]).map((s) => resolveStudent(session, s)));
          return createAndSend(session, {
            body,
            messageType: MESSAGE_TYPE.absence,
            properties: {
              AbsentStudent: [...new Set(absent.map((s) => s.ID))].join(","),
              AbsenceDate: absence_date,
              ...(absence_reason ? { AbsenceReason: absence_reason } : {}),
            },
          });
        }
        if (kind === "school") {
          if (!messaging.ParentsSchoolMessage) throw new Error("This school doesn't accept messages from parents to the school through Daymap.");
          return createAndSend(session, { body, messageType: MESSAGE_TYPE.school });
        }
        if (!(messaging.ParentsToStaff || messaging.StudentParentMessage)) {
          throw new Error("This school doesn't let parents message people directly through Daymap.");
        }
        if (!contact_ids?.length) throw new Error("A message to a person needs contact_ids.");
        const allowed = new Set(
          ContactListSchema.parse(await session.json("GET", "/lms/api/coms/messagecontactlist")).flatMap((entry) => [
            ...(entry.Student && entry.CanMessageStudent !== false ? [entry.Student.ContactID] : []),
            ...(entry.Teachers ?? []).map((t) => t.ContactID),
            ...(entry.Leaders ?? []).map((l) => l.ContactID),
          ]),
        );
        const refused = contact_ids.filter((id) => !allowed.has(id));
        if (refused.length > 0) {
          throw new Error(`Can't message ContactID(s) ${refused.join(", ")}; see daymap_message_recipients for who you can message.`);
        }
        return createAndSend(session, { body, messageType: MESSAGE_TYPE.person, contactIds: contact_ids });
      }),
  );

  server.registerTool(
    "daymap_save_form_record",
    {
      title: "Fill in or update a form",
      description:
        "Creates or updates a record in a Daymap form for a student (e.g. a consent or permission form), " +
        "optionally running a workflow action such as Submit. Get FieldIDs, field types, options and action " +
        "IDs from daymap_records first. Fields you don't give keep their current values. Values are text: " +
        "dates YYYY-MM-DD, date-times YYYY-MM-DDTHH:mm, checkboxes true/false, lists the option value. " +
        "Payment fields can't be filled in.",
      inputSchema: {
        student: studentArg,
        form_id: idArg.describe("Form ID."),
        record_id: idArg.optional().describe("Existing record (RowId) to update; leave out to create one."),
        action_id: idArg.optional().describe("Workflow action to run on save (e.g. Submit), from the form's actions."),
        fields: z
          .array(z.object({ field_id: idArg, value: z.union([z.string(), z.boolean(), z.number()]) }))
          .min(1)
          .describe("Fields to set."),
      },
      annotations: WRITE,
    },
    ({ student, form_id, record_id, action_id, fields }) =>
      attempt(async () => {
        const s = await resolveStudent(session, student);
        const current = FormRecordSchema.parse(
          await session.json(
            "GET",
            `/lms/api/forms/record${query({
              formid: form_id,
              id: s.ID,
              rowId: record_id ?? 0,
              editMode: record_id === undefined ? 2 : 1, // New : Edit
              loadItems: true,
            })}`,
          ),
        );
        if (record_id !== undefined && current.Record?.CanEdit === false) {
          throw new Error("Daymap doesn't let you edit this record.");
        }
        const items = new Map(current.Form.Items.map((item) => [item.FieldID, item]));
        const given = new Map(fields.map((f) => [f.field_id, f.value]));
        for (const id of given.keys()) {
          const item = items.get(id);
          if (!item) throw new Error(`Form ${form_id} has no field ${id}.`);
          if (item.ControlType === CONTROL.paymentField || item.ControlType === CONTROL.paymentFieldOld) {
            throw new Error(`"${item.Caption ?? id}" is a payment field; payments can't be made through this connector.`);
          }
        }
        const results = record_id === undefined ? {} : (current.Record?.Results ?? {});
        // Like the portal, send every field: the new value where given, otherwise the current one.
        const values = current.Form.Items.map((item) => ({
          FieldID: item.FieldID,
          Value: formValue(
            item.ControlType,
            given.has(item.FieldID) ? given.get(item.FieldID) : results[String(item.FieldID)]?.Value,
          ),
        }));
        const saved = await session.json(
          "POST",
          `/lms/api/forms/record/save${query({ formId: form_id, id: s.ID, rowid: record_id, actionId: action_id, async: false })}`,
          values,
        );
        return `Saved.\n\n${renderData(saved)}`;
      }),
  );

  server.registerTool(
    "daymap_excursion_consent",
    {
      title: "Give or decline excursion consent",
      description:
        "Gives, declines or withdraws the parent's consent for a student to attend an excursion (an event " +
        "ID from daymap_excursion / daymap_timetable). Consent can't be changed once it has expired.",
      inputSchema: {
        student: studentArg,
        event_id: idArg.describe("Excursion/event ID."),
        decision: z.enum(["give", "decline", "withdraw"]).describe("give consent, decline it, or withdraw a previous answer."),
      },
      annotations: WRITE,
    },
    ({ student, event_id, decision }) =>
      attempt(async () => {
        const s = await resolveStudent(session, student);
        const excursion = ExcursionSchema.parse(
          await session.json("GET", `/lms/api/projects/excursions/event/${event_id}${query({ studentId: s.ID })}`),
        );
        if (!excursion.ProjectId) throw new Error("Daymap didn't return an excursion for this event.");
        if (excursion.ConsentStatus === 3 || excursion.ConsentExpiryPassed) {
          throw new Error("Consent for this excursion has expired and can't be changed.");
        }
        const status = { give: 1, decline: 2, withdraw: 0 }[decision];
        await session.json("POST", `/lms/api/projects/excursions/${excursion.ProjectId}/consent/${s.ID}`, {
          Status: status,
        });
        return `Consent ${decision === "give" ? "given" : decision === "decline" ? "declined" : "withdrawn"}.`;
      }),
  );

  server.registerTool(
    "daymap_book_interview",
    {
      title: "Book a parent-teacher interview",
      description:
        "Books a parent-teacher interview slot for a student with a teacher. Get the round, slot, teacher " +
        "and allowed meeting methods (ParentOptions) from daymap_interviews.",
      inputSchema: {
        student: studentArg,
        group_id: idArg.describe("Interview round (group) ID."),
        slot_id: idArg.describe("Slot ID."),
        staff_id: idArg.describe("Teacher's staff ID."),
        class_id: idArg.optional().describe("The class the interview is about, if any."),
        method: z.string().min(1).describe("Meeting method, one of the round's ParentOptions."),
        interpreter_language: z.string().optional().describe("Language, if an interpreter is needed."),
      },
      annotations: WRITE,
    },
    ({ student, group_id, slot_id, staff_id, class_id, method, interpreter_language }) =>
      attempt(async () => {
        const s = await resolveStudent(session, student);
        const group = InterviewGroupSchema.parse(await session.json("GET", `/lms/api/interviews/${group_id}`));
        const options = group.ParentOptions ?? [];
        if (options.length > 0 && !options.includes(method)) {
          throw new Error(`"${method}" isn't offered for this round; choose one of: ${options.join(", ")}.`);
        }
        await session.json(
          "POST",
          `/lms/api/interviews/${group_id}/slot/${slot_id}/book${query({
            staffId: staff_id,
            studentId: s.ID,
            classId: class_id ?? 0,
            method,
            requiresInterpreter: interpreter_language ? true : undefined,
            interpreterLanguage: interpreter_language,
          })}`,
        );
        return "Interview booked.";
      }),
  );

  server.registerTool(
    "daymap_cancel_interview",
    {
      title: "Cancel a parent-teacher interview",
      description: "Cancels a booked parent-teacher interview slot (IDs from daymap_interviews).",
      inputSchema: {
        group_id: idArg.describe("Interview round (group) ID."),
        slot_id: idArg.describe("Slot ID."),
        staff_id: idArg.describe("Teacher's staff ID."),
      },
      annotations: WRITE,
    },
    ({ group_id, slot_id, staff_id }) =>
      attempt(async () => {
        const sentVia = (await clientSettings(session)).interviewAlertNotificationSendVia ?? 4;
        await session.json(
          "POST",
          `/lms/api/interviews/${group_id}/slot/${slot_id}/cancel${query({ staffId: staff_id, sentVia })}`,
        );
        return "Interview cancelled.";
      }),
  );
}
