import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaymapSession } from "./session.js";
import { renderData } from "./render.js";
import { READ, attempt, clientSettings, dateArg, idArg, query, resolveStudent, studentArg } from "./common.js";

const MESSAGE_FOLDERS: Record<string, string> = { inbox: "1", sent: "2", archived: "3", email_sms: "10" };

const pageArg = z.number().int().min(1).default(1).describe("Page number, starting at 1.");
const pageSizeArg = (fallback: number) =>
  z.number().int().min(1).max(100).default(fallback).describe(`Items per page (default ${fallback}).`);

/** Daymap's search parameters are URL-encoded twice by the portal, and the server decodes them twice. */
const doubleEncode = (value: string | undefined) =>
  value === undefined ? undefined : encodeURIComponent(value);

function assertRange(from: string, to: string) {
  if (to < from) throw new Error(`"to" (${to}) is before "from" (${from}).`);
}

const TaskSchema = z.looseObject({
  task: z.looseObject({ RubricID: z.number().nullish(), PublishedOn: z.string().nullish() }).optional(),
});
const ResultsSchema = z.looseObject({ Published: z.string().nullish() });
const LessonSchema = z.looseObject({
  Event: z.looseObject({}).optional(),
  Plans: z.array(z.looseObject({ NoteID: z.number().optional() })).nullish(),
});

/** Strips the class roster (other children's details) from a lesson or event. */
function withoutClassmates(event: Record<string, unknown> | undefined) {
  if (!event) return event;
  const { Students: _roster, ...rest } = event;
  return rest;
}

export function registerReadTools(server: McpServer, session: DaymapSession): void {
  server.registerTool(
    "daymap_students",
    {
      title: "Students",
      description:
        "Lists the students (children) linked to this parent account: ID, year level, roll class (Form), " +
        "house and date of birth, plus the parent's own details. Other tools take a student name or ID.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      attempt(async () => {
        const [parent, students] = await Promise.all([
          session.json("GET", "/lms/api/contact/user"),
          session.json("GET", "/lms/api/contact/studentsforcontact"),
        ]);
        return renderData({ Parent: parent, Students: students });
      }),
  );

  server.registerTool(
    "daymap_timetable",
    {
      title: "Timetable and diary",
      description:
        "A student's diary between two dates: timetabled lessons (with period, room, teacher and " +
        "attendance status), assessment tasks (Start = set date, Finish = due date), calendar events, " +
        "excursions and interviews. Type: 1 Note, 2 Lesson, 3 Calendar event, 4 Daily organiser change, " +
        "5 Task, 6 Interview, 7 Student record, 8 Excursion. A lesson's ID can be passed to daymap_lesson " +
        "for its lesson plan/homework; a task's ID to daymap_assessment_task.",
      inputSchema: {
        student: studentArg,
        from: dateArg.describe("First date (YYYY-MM-DD)."),
        to: dateArg.optional().describe("Last date (YYYY-MM-DD), default the same as from."),
      },
      annotations: READ,
    },
    ({ student, from, to = from }) =>
      attempt(async () => {
        assertRange(from, to);
        const s = await resolveStudent(session, student);
        return renderData(
          await session.json("GET", `/lms/api/calendars/diaryitems${query({ from, to, studentID: s.ID })}`),
        );
      }),
  );

  server.registerTool(
    "daymap_lesson",
    {
      title: "Lesson details",
      description:
        "Details of one timetabled lesson (an ID from daymap_timetable): class, teacher, room, the " +
        "student's attendance for it, and the lesson plans/homework the teacher has shared, with their " +
        "full text. The class list is left out.",
      inputSchema: { student: studentArg, lesson_id: idArg.describe("Lesson (event) ID.") },
      annotations: READ,
    },
    ({ student, lesson_id }) =>
      attempt(async () => {
        const s = await resolveStudent(session, student);
        const lesson = LessonSchema.parse(
          await session.json(
            "GET",
            `/lms/api/calendar/timetable/event/details${query({ eventID: lesson_id, studentID: s.ID })}`,
          ),
        );
        const plans = await Promise.all(
          (lesson.Plans ?? []).map(async (plan) =>
            plan.NoteID === undefined
              ? plan
              : {
                  ...plan,
                  ...(await session.json<Record<string, unknown>>(
                    "GET",
                    `/lms/api/curriculum/lesson/plan/lessonnote${query({ planId: plan.NoteID, eventId: lesson_id })}`,
                  )),
                },
          ),
        );
        return renderData({ ...lesson, Event: withoutClassmates(lesson.Event), Plans: plans });
      }),
  );

  server.registerTool(
    "daymap_attendance",
    {
      title: "Attendance",
      description:
        "A student's attendance this year: per-class rates (approved/unapproved absence counts and " +
        "percentages) and a day-by-day history. Each day has AbsenceType (1 no roll marked, 2 unmarked " +
        "roll, 3 present, 4 late, 5 approved absence, 6 unapproved absence) and a description listing each " +
        "period's status and reason. By default only days with a late arrival or absence are listed.",
      inputSchema: {
        student: studentArg,
        class_id: idArg.optional().describe("Limit to one class (ClassID from the rates)."),
        from: dateArg.optional().describe("Only list days from this date (YYYY-MM-DD)."),
        to: dateArg.optional().describe("Only list days up to this date (YYYY-MM-DD)."),
        absences_only: z
          .boolean()
          .default(true)
          .describe("List only days with a late arrival or absence (default true); false lists every day."),
      },
      annotations: READ,
    },
    ({ student, class_id, from, to, absences_only }) =>
      attempt(async () => {
        if (from && to) assertRange(from, to);
        const s = await resolveStudent(session, student);
        const params = query({ classId: class_id });
        const [rates, map] = await Promise.all([
          session.json("GET", `/lms/api/student/attendancerates/${s.ID}${params}`),
          session.json<Record<string, { AbsenceType?: number }> | null>(
            "GET",
            `/lms/api/attendance/reports/attendancemap/${s.ID}${params}`,
          ),
        ]);
        const days = Object.entries(map ?? {}).filter(([date, day]) => {
          const d = date.slice(0, 10);
          if ((from && d < from) || (to && d > to)) return false;
          return !absences_only || [4, 5, 6].includes(day?.AbsenceType ?? 0);
        });
        return renderData({
          Rates: rates,
          Days: days.length > 0 ? Object.fromEntries(days) : absences_only ? "No late arrivals or absences." : undefined,
        });
      }),
  );

  server.registerTool(
    "daymap_assessment",
    {
      title: "Assessment tasks",
      description:
        "A student's assessment tasks: class, type (Draft/Final), set and due dates, status, whether " +
        "it's been marked and results published, and the teacher's description. Use daymap_assessment_task " +
        "with a TaskID for marks, feedback and rubric.",
      inputSchema: {
        student: studentArg,
        range: z
          .enum(["current", "this_year", "all"])
          .default("current")
          .describe("current = this term's tasks (default); this_year; all = every year."),
        class_code: z.string().optional().describe("Limit to one class, e.g. 'ENG08 E'."),
        from: dateArg.optional().describe("Only tasks due on or after this date (YYYY-MM-DD)."),
        to: dateArg.optional().describe("Only tasks due on or before this date (YYYY-MM-DD)."),
      },
      annotations: READ,
    },
    ({ student, range, class_code, from, to }) =>
      attempt(async () => {
        if (from && to) assertRange(from, to);
        const s = await resolveStudent(session, student);
        const dateRange = { current: "Current", this_year: "ThisYear", all: "All" }[range];
        return renderData(
          await session.json(
            "GET",
            `/lms/api/assessment/studenttasklist${query({
              studentId: s.ID,
              allPublished: false,
              classCode: class_code,
              from,
              to,
              dateRange,
            })}`,
          ),
        );
      }),
  );

  server.registerTool(
    "daymap_assessment_task",
    {
      title: "Assessment task details and results",
      description:
        "One assessment task (a TaskID from daymap_assessment or daymap_timetable): description, outcomes, " +
        "drafts/subtasks, the student's mark, grade and teacher comments once results are published, " +
        "submitted work, and the rubric with the student's marks if the task has one.",
      inputSchema: { student: studentArg, task_id: idArg.describe("Assessment TaskID.") },
      annotations: READ,
    },
    ({ student, task_id }) =>
      attempt(async () => {
        const s = await resolveStudent(session, student);
        const ids = query({ studentId: s.ID, taskId: task_id });
        const [task, results] = await Promise.all([
          session.json("GET", `/lms/api/assessment/gettaskandoutcomes${ids}`),
          session.json("GET", `/lms/api/assessment/studentresults${ids}`),
        ]);
        const parsedTask = TaskSchema.parse(task ?? {});
        // Like the portal, only show results (and rubric marks) once they're published.
        const published = ResultsSchema.safeParse(results ?? {}).data?.Published ?? parsedTask.task?.PublishedOn;
        const isPublished = !!published && Date.parse(published) <= Date.now();
        const rubricId = parsedTask.task?.RubricID;
        const [rubric, rubricMarks] = await Promise.all([
          rubricId ? session.json("GET", `/lms/api/assessment/rubric/${rubricId}`) : undefined,
          rubricId && isPublished ? session.json("GET", `/lms/api/assessment/studentresults/rubrics${ids}`) : undefined,
        ]);
        return renderData({
          ...parsedTask,
          Results: isPublished ? results : "Results haven't been published yet.",
          Rubric: rubric,
          RubricMarks: rubricMarks,
        });
      }),
  );

  server.registerTool(
    "daymap_notices",
    {
      title: "School notices",
      description:
        "School notices (bulletins) from the school, newest first: subject, sender, date, a preview of " +
        "the text, priority (100+ is important) and expiry. Open one with daymap_message_thread for the " +
        "full text.",
      inputSchema: {
        page: pageArg,
        page_size: pageSizeArg(20),
        important_only: z.boolean().optional().describe("Only important notices."),
        include_expired: z.boolean().optional().describe("Include notices that have expired."),
        search: z.string().optional().describe("Only notices containing this text."),
      },
      annotations: READ,
    },
    ({ page, page_size, important_only, include_expired, search }) =>
      attempt(async () =>
        renderData(
          await session.json(
            "GET",
            `/lms/api/coms/folder/bulletins${query({
              page,
              maxMessages: page_size,
              feedOnly: true,
              importantOnly: important_only || undefined,
              expired: include_expired || undefined,
              search: doubleEncode(search),
            })}`,
          ),
        ),
      ),
  );

  server.registerTool(
    "daymap_messages",
    {
      title: "Messages",
      description:
        "Lists the parent's Daymap messages in a folder (inbox, sent, archived, or email_sms for absence " +
        "texts and emails), newest first, or searches all messages. Each has MessageID, subject, sender, " +
        "date, read flag and a preview. MessageType: 1 school post, 2 admin, 3 alert, 4 absence, 5 to the " +
        "school, 6 absence notification, 10 personal, 11 post, 12 post reply, 13 excursion. Open one with " +
        "daymap_message_thread.",
      inputSchema: {
        folder: z
          .string()
          .default("inbox")
          .describe("inbox (default), sent, archived, email_sms, or a folder ID."),
        page: pageArg,
        page_size: pageSizeArg(20),
        unread_only: z.boolean().optional().describe("Only unread messages."),
        keyword: z.string().optional().describe("Search for messages containing this text (searches the folder)."),
        sender: z.string().optional().describe("Search by sender name."),
        sent_from: dateArg.optional().describe("Search: sent on or after (YYYY-MM-DD)."),
        sent_to: dateArg.optional().describe("Search: sent on or before (YYYY-MM-DD)."),
      },
      annotations: READ,
    },
    ({ folder, page, page_size, unread_only, keyword, sender, sent_from, sent_to }) =>
      attempt(async () => {
        const folderId = MESSAGE_FOLDERS[folder.toLowerCase()] ?? folder;
        if (!/^\d+$/.test(folderId)) {
          throw new Error(`Unknown folder "${folder}". Use inbox, sent, archived, email_sms or a folder ID.`);
        }
        const searching = keyword || sender || sent_from || sent_to;
        const path = searching
          ? `/lms/api/coms/messages/search${query({
              page,
              msgsPerPage: page_size,
              folder: folderId,
              keyword: doubleEncode(keyword),
              sender: doubleEncode(sender),
              sentFrom: sent_from,
              sentTo: sent_to,
              unreadOnly: unread_only || undefined,
            })}`
          : `/lms/api/coms/folder/${folderId}${query({ page, msgsPerPage: page_size, unReadOnly: unread_only || undefined })}`;
        return renderData(await session.json("GET", path));
      }),
  );

  server.registerTool(
    "daymap_message_thread",
    {
      title: "Read a message",
      description:
        "Opens a message or school notice (a MessageID) with its whole conversation thread and full text. " +
        "actionMask says what the parent can do: 2 reply all, 4 archive, 512 reply. Daymap may record the " +
        "message as read when it's opened.",
      inputSchema: { message_id: idArg.describe("MessageID.") },
      annotations: READ,
    },
    ({ message_id }) =>
      attempt(async () => renderData(await session.json("GET", `/lms/api/coms/message/${message_id}/thread`))),
  );

  server.registerTool(
    "daymap_notifications",
    {
      title: "Notifications (timeline)",
      description:
        "The parent's notification timeline, newest first: points awarded, results published, absences, " +
        "new records, messages, interviews, excursions and calendar changes, with read status. " +
        "NotificationType: 1 points, 2 assessment published, 3 new record, 4 record comment, 5 unapproved " +
        "absence, 6 message, 7 interview, 8 excursion, 13/19 calendar event updated/created.",
      inputSchema: {
        student: z.string().optional().describe("Student name or ID; leave out for every student."),
        page: pageArg,
        page_size: pageSizeArg(20),
      },
      annotations: READ,
    },
    ({ student, page, page_size }) =>
      attempt(async () => {
        const studentId = student ? (await resolveStudent(session, student)).ID : undefined;
        return renderData(
          await session.json(
            "GET",
            `/lms/api/coms/notifications${query({ pageNum: page, itemsPerPage: page_size, studentId })}`,
          ),
        );
      }),
  );

  server.registerTool(
    "daymap_calendar",
    {
      title: "School calendar",
      description:
        "School and family calendar events between two dates, plus the student's non-lesson diary items " +
        "(tasks due, excursions, interviews, events). For lessons use daymap_timetable.",
      inputSchema: {
        student: studentArg,
        from: dateArg.describe("First date (YYYY-MM-DD)."),
        to: dateArg.describe("Last date (YYYY-MM-DD)."),
      },
      annotations: READ,
    },
    ({ student, from, to }) =>
      attempt(async () => {
        assertRange(from, to);
        const s = await resolveStudent(session, student);
        const [family, studentItems] = await Promise.all([
          session.json("GET", `/lms/api/calendars/diaryitems${query({ from, to })}`),
          session.json(
            "GET",
            `/lms/api/calendars/diaryitems${query({ from, to, studentID: s.ID, nonTimetableOnly: true })}`,
          ),
        ]);
        return renderData({ FamilyEvents: family, StudentItems: studentItems });
      }),
  );

  server.registerTool(
    "daymap_message_recipients",
    {
      title: "Who the parent can message",
      description:
        "Before sending a message: which kinds of message this school lets parents send (absence " +
        "notification, message to the school, message to teachers or their child) and the people who can " +
        "be messaged, by ContactID.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      attempt(async () => {
        const [settings, contacts] = await Promise.all([
          clientSettings(session),
          session.json("GET", "/lms/api/coms/messagecontactlist"),
        ]);
        const m = settings.Messaging ?? {};
        return renderData({
          AllowedMessageKinds: {
            absence: !!m.ParentsAbsenceMessage,
            school: !!m.ParentsSchoolMessage,
            person: !!(m.ParentsToStaff || m.StudentParentMessage),
          },
          Contacts: contacts,
        });
      }),
  );

  server.registerTool(
    "daymap_records",
    {
      title: "Forms and records",
      description:
        "Forms and records the parent can see for a student (e.g. excursion approvals, consent forms). " +
        "Without form_id: the list of forms with record counts. With form_id: that form's fields " +
        "(FieldID, caption, type, options) and the student's records. With record_id too: one record. " +
        "Needed before daymap_save_form_record.",
      inputSchema: {
        student: studentArg,
        form_id: idArg.optional().describe("Form ID."),
        record_id: idArg.optional().describe("Record (RowId) within the form."),
      },
      annotations: READ,
    },
    ({ student, form_id, record_id }) =>
      attempt(async () => {
        if (record_id !== undefined && form_id === undefined) throw new Error("record_id needs form_id too.");
        const s = await resolveStudent(session, student);
        if (form_id === undefined) {
          const [forms, counts] = await Promise.all([
            session.json("GET", "/lms/api/forms/lists/student?hideCalendarForms=false"),
            session.json("GET", `/lms/api/records/studentsummary${query({ studentId: s.ID, includeExpired: 1 })}`),
          ]);
          return renderData({ Forms: forms, RecordCounts: counts });
        }
        const path =
          record_id === undefined
            ? `/lms/api/records/list/student${query({ studentId: s.ID, id: s.ID, formId: form_id, includeExpired: true })}`
            : `/lms/api/forms/record${query({ formid: form_id, id: s.ID, rowId: record_id, loadItems: true })}`;
        return renderData(await session.json("GET", path));
      }),
  );

  server.registerTool(
    "daymap_excursion",
    {
      title: "Excursion and consent status",
      description:
        "An excursion or event needing consent (an ID from daymap_timetable or daymap_calendar, Type 8 or " +
        "with ConsentRecords): details, ConsentStatus (0 pending, 1 given, 2 declined, 3 expired), " +
        "ConsentRequired, ConsentExpiry and the related forms.",
      inputSchema: { student: studentArg, event_id: idArg.describe("Excursion/event ID.") },
      annotations: READ,
    },
    ({ student, event_id }) =>
      attempt(async () => {
        const s = await resolveStudent(session, student);
        const [excursion, consentRecords, event] = await Promise.all([
          session.json("GET", `/lms/api/projects/excursions/event/${event_id}${query({ studentId: s.ID })}`),
          session.json("GET", `/lms/api/forms/record/consentFromEvent${query({ Id: event_id, StudentId: s.ID })}`),
          session.json<{ Event?: Record<string, unknown> }>(
            "GET",
            `/lms/api/calendar/timetable/event/details${query({ eventID: event_id, studentID: s.ID })}`,
          ),
        ]);
        return renderData({
          Excursion: excursion,
          ConsentRecords: consentRecords,
          Event: withoutClassmates(event?.Event),
        });
      }),
  );

  server.registerTool(
    "daymap_interviews",
    {
      title: "Parent-teacher interviews",
      description:
        "Parent-teacher interview rounds. Without group_id: the rounds (ID, name, dates, status). With " +
        "group_id: the round's details including booking methods (ParentOptions), its time slots with " +
        "bookings, and the teachers available. Needed before booking or cancelling.",
      inputSchema: { group_id: idArg.optional().describe("Interview round (group) ID.") },
      annotations: READ,
    },
    ({ group_id }) =>
      attempt(async () => {
        if (group_id === undefined) {
          return renderData(await session.json("GET", "/lms/api/interviews/groups?from=&to="));
        }
        const [group, slots, teachers] = await Promise.all([
          session.json("GET", `/lms/api/interviews/${group_id}`),
          session.json("GET", `/lms/api/interviews/${group_id}/slots`),
          session.json("GET", `/lms/api/interviews/${group_id}/teachers`),
        ]);
        return renderData({ Group: group, Slots: slots, Teachers: teachers });
      }),
  );
}
