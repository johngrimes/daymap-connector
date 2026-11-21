import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/tools.ts";
import { DaymapSchool } from "../src/session.ts";
import { startMockDaymap, type ApiCall, type ApiReply, type MockDaymap } from "./mock-daymap.ts";

/**
 * Drives the MCP tools through a real client and a real DaymapSession, against the
 * mock Daymap site. Each test sets the API routes it needs.
 */
let mock: MockDaymap;
let client: Client;
let routes: Record<string, ApiReply | ((call: ApiCall) => ApiReply)>;

const ALEX = { ID: 7, ContactID: 70, Firstname: "Alex", Surname: "Smith", DisplaynameSurname: "Alex Smith" };
const SAM = { ID: 8, ContactID: 80, Firstname: "Sam", Surname: "Smith", DisplaynameSurname: "Sam Smith" };
const MESSAGING_ON = {
  Messaging: { ParentsAbsenceMessage: true, ParentsSchoolMessage: true, ParentsToStaff: false, StudentParentMessage: true },
  interviewAlertNotificationSendVia: 2,
};

before(async () => {
  mock = await startMockDaymap();
  const school = new DaymapSchool(mock.base);
  const session = school.session((await school.signIn("parent", "secret")).access);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createServer(session).connect(serverSide);
  client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
});

after(() => mock.close());

beforeEach(() => {
  mock.reset();
  routes = {
    "GET /lms/api/contact/studentsforcontact": { body: [ALEX] },
    "GET /lms/api/settings/clientsettings": { body: MESSAGING_ON },
  };
  // Routes match on "METHOD path?query" first, then "METHOD path".
  mock.setApi((call) => {
    const route = routes[`${call.method} ${call.path}`] ?? routes[`${call.method} ${call.path.split("?")[0]}`];
    return typeof route === "function" ? route(call) : route;
  });
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content[0].text, isError: result.isError === true };
}

/** The API calls made, ignoring the student and settings lookups. */
function writes() {
  return mock.state.apiCalls
    .filter((c) => c.method !== "GET")
    .map((c) => ({ method: c.method, path: c.path, body: c.body ? JSON.parse(c.body) : undefined }));
}

// --- Choosing a student ---

test("a single child is used automatically", async () => {
  routes["GET /lms/api/calendars/diaryitems"] = { body: [{ ID: 1, Type: 2, Title: "English" }] };
  const { text, isError } = await callTool("daymap_timetable", { from: "2026-11-20" });
  assert.equal(isError, false);
  assert.match(text, /Title: English/);
  assert.ok(mock.state.apiCalls.some((c) => c.path === "/lms/api/calendars/diaryitems?from=2026-11-20&to=2026-11-20&studentID=7"));
});

test("with several children, the tool asks which one, and matches by name or ID", async () => {
  routes["GET /lms/api/contact/studentsforcontact"] = { body: [ALEX, SAM] };
  routes["GET /lms/api/calendars/diaryitems"] = { body: [] };
  const ask = await callTool("daymap_timetable", { from: "2026-11-20" });
  assert.equal(ask.isError, true);
  assert.match(ask.text, /more than one student.*Alex Smith \(ID 7\), Sam Smith \(ID 8\)/);
  assert.match((await callTool("daymap_timetable", { from: "2026-11-20", student: "sam" })).text, /no data/);
  assert.match((await callTool("daymap_timetable", { from: "2026-11-20", student: "8" })).text, /no data/);
  assert.match((await callTool("daymap_timetable", { from: "2026-11-20", student: "smith" })).text, /matches more than one/);
  assert.ok(mock.state.apiCalls.filter((c) => c.path.endsWith("studentID=8")).length === 2);
});

test("dates must be real YYYY-MM-DD dates in order", async () => {
  assert.equal((await callTool("daymap_timetable", { from: "20/11/2026" })).isError, true);
  assert.equal((await callTool("daymap_timetable", { from: "2026-02-30" })).isError, true);
  const backwards = await callTool("daymap_calendar", { from: "2026-11-20", to: "2026-11-01" });
  assert.equal(backwards.isError, true);
  assert.match(backwards.text, /before/);
});

// --- Reads ---

test("lesson details leave out the class list and include full lesson plans", async () => {
  routes["GET /lms/api/calendar/timetable/event/details"] = {
    body: { Event: { Id: 5, Title: "English", Students: [{ Name: "Another Child" }] }, Plans: [{ NoteID: 9, Title: "Homework", Note: "" }] },
  };
  routes["GET /lms/api/curriculum/lesson/plan/lessonnote?planId=9&eventId=5"] = {
    body: { NoteID: 9, Note: "<p>Read <b>chapter 3</b></p>" },
  };
  const { text } = await callTool("daymap_lesson", { lesson_id: 5 });
  assert.doesNotMatch(text, /Another Child|Students/);
  assert.match(text, /Read \*\*chapter 3\*\*/);
});

test("attendance lists only lates and absences by default, within the dates asked", async () => {
  routes["GET /lms/api/student/attendancerates/7"] = { body: [{ ClassCode: "8E", ApprovedPercent: "91%" }] };
  routes["GET /lms/api/attendance/reports/attendancemap/7"] = {
    body: {
      "2026-02-02T00:00:00": { AbsenceType: 3, AbsenceDescription: "present" },
      "2026-02-03T00:00:00": { AbsenceType: 6, AbsenceDescription: "unexplained" },
      "2026-03-03T00:00:00": { AbsenceType: 5, AbsenceDescription: "sick" },
    },
  };
  const { text } = await callTool("daymap_attendance", { to: "2026-02-28" });
  assert.match(text, /ApprovedPercent: 91%/);
  assert.match(text, /unexplained/);
  assert.doesNotMatch(text, /present|sick/);
  assert.match((await callTool("daymap_attendance", { absences_only: false })).text, /present/);
});

test("assessment results stay hidden until published, like the portal", async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  routes["GET /lms/api/assessment/gettaskandoutcomes"] = { body: { task: { Name: "Essay", RubricID: 3, PublishedOn: null } } };
  routes["GET /lms/api/assessment/studentresults"] = { body: { Results: [{ Grade: "B" }], Published: future } };
  routes["GET /lms/api/assessment/rubric/3"] = { body: { Title: "Essay rubric" } };
  routes["GET /lms/api/assessment/studentresults/rubrics"] = { body: { Marks: [{ Mark: 4 }] } };
  const hidden = await callTool("daymap_assessment_task", { task_id: 1 });
  assert.match(hidden.text, /haven't been published/);
  assert.doesNotMatch(hidden.text, /Grade|Mark: 4/);
  assert.match(hidden.text, /Essay rubric/);

  routes["GET /lms/api/assessment/studentresults"] = { body: { Results: [{ Grade: "B" }], Published: "2026-01-01T00:00:00" } };
  const shown = await callTool("daymap_assessment_task", { task_id: 1 });
  assert.match(shown.text, /Grade: B/);
  assert.match(shown.text, /Mark: 4/);
});

test("messages map folder names and search with Daymap's double encoding", async () => {
  routes["GET /lms/api/coms/folder/3"] = { body: [{ MessageID: 1, Subject: "Old" }] };
  routes["GET /lms/api/coms/messages/search"] = { body: [{ MessageID: 2, Subject: "Found" }] };
  assert.match((await callTool("daymap_messages", { folder: "archived", unread_only: true })).text, /Subject: Old/);
  assert.ok(mock.state.apiCalls.some((c) => c.path === "/lms/api/coms/folder/3?page=1&msgsPerPage=20&unReadOnly=true"));
  assert.match((await callTool("daymap_messages", { keyword: "a&b c" })).text, /Subject: Found/);
  const search = mock.state.apiCalls.find((c) => c.path.startsWith("/lms/api/coms/messages/search"))!;
  assert.equal(new URL(search.path, mock.base).searchParams.get("keyword"), encodeURIComponent("a&b c"));
  assert.equal((await callTool("daymap_messages", { folder: "junk" })).isError, true);
});

test("the generic read tool refuses endpoints that change data", async () => {
  const { text, isError } = await callTool("daymap_api_get", { path: "/lms/api/coms/notifications/setread/4" });
  assert.equal(isError, true);
  assert.match(text, /changes data/);
  const sneaky = await callTool("daymap_api_get", { path: "/lms/api/coms/notifications/%73etread/5/%zz%2f.." });
  assert.equal(sneaky.isError, true);
  const payment = await callTool("daymap_api_request", { method: "DELETE", path: "/lms/api/%70ayments/customer/%zz%2f.." });
  assert.equal(payment.isError, true);
  assert.equal(mock.state.apiCalls.length, 0);
});

test("the generic read tool shows Daymap's error replies as errors", async () => {
  const { text, isError } = await callTool("daymap_api_get", { path: "/lms/api/nothing-here" });
  assert.equal(isError, true);
  assert.match(text, /Status: 404/);
});

// --- Writes ---

test("marking messages read and archiving send the portal's requests", async () => {
  routes["PATCH /lms/api/coms/message/read"] = { status: 204 };
  routes["PATCH /lms/api/coms/message/archive"] = { status: 204 };
  assert.equal((await callTool("daymap_mark_messages_read", { message_ids: [1, 2], read: false })).isError, false);
  assert.equal((await callTool("daymap_archive_messages", { message_ids: [3] })).isError, false);
  assert.deepEqual(writes(), [
    { method: "PATCH", path: "/lms/api/coms/message/read", body: { MessageIds: [1, 2], Read: false } },
    { method: "PATCH", path: "/lms/api/coms/message/archive", body: [3] },
  ]);
});

test("notifications are marked read one at a time or all at once", async () => {
  routes["GET /lms/api/coms/notifications/setread/12"] = { status: 204 };
  routes["GET /lms/api/coms/notifications/setread"] = { status: 204 };
  await callTool("daymap_mark_notifications_read", { notification_id: 12 });
  await callTool("daymap_mark_notifications_read", {});
  assert.deepEqual(
    mock.state.apiCalls.map((c) => c.path),
    ["/lms/api/coms/notifications/setread/12", "/lms/api/coms/notifications/setread"],
  );
});

test("a reply creates a draft in the thread and sends it", async () => {
  routes["GET /lms/api/coms/message/50/thread"] = { body: { actionMask: 512 | 4, messages: [{ MessageID: 50, ThreadID: 40 }] } };
  routes["POST /lms/api/coms/message/create"] = { body: { MessageID: 51, ThreadID: 40, MessageType: 10 } };
  routes["POST /lms/api/coms/draft/send"] = { body: { MessageID: 51, Subject: "Re: shoes" } };
  const { text, isError } = await callTool("daymap_reply_to_message", { message_id: 50, body: "Thanks!" });
  assert.equal(isError, false);
  assert.match(text, /Sent/);
  assert.deepEqual(writes(), [
    { method: "POST", path: "/lms/api/coms/message/create", body: { body: "Thanks!", threadID: 40, replyAll: false } },
    { method: "POST", path: "/lms/api/coms/draft/send", body: { ThreadID: 40, MessageID: 51, MessageType: 10 } },
  ]);
});

test("replying is refused where the thread doesn't allow it", async () => {
  routes["GET /lms/api/coms/message/50/thread"] = { body: { actionMask: 4, messages: [{ MessageID: 50, ThreadID: 40 }] } };
  const { text, isError } = await callTool("daymap_reply_to_message", { message_id: 50, body: "Hi" });
  assert.equal(isError, true);
  assert.match(text, /doesn't allow replies/);
  assert.equal((await callTool("daymap_reply_to_message", { message_id: 50, body: "Hi", reply_all: true })).isError, true);
  assert.deepEqual(writes(), []);
});

test("an absence notification names the students by ID and the date", async () => {
  routes["GET /lms/api/contact/studentsforcontact"] = { body: [ALEX, SAM] };
  routes["POST /lms/api/coms/message/create"] = { body: { MessageID: 60, ThreadID: 60, MessageType: 6 } };
  routes["POST /lms/api/coms/draft/send"] = { body: { MessageID: 60 } };
  const result = await callTool("daymap_send_message", {
    kind: "absence",
    body: "Both unwell today.",
    students: ["Alex", "Sam"],
    absence_date: "2026-11-23",
  });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(writes()[0].body, {
    body: "Both unwell today.",
    messageType: 6,
    properties: { AbsentStudent: "7,8", AbsenceDate: "2026-11-23" },
  });
});

test("message kinds the school has switched off are refused before anything is sent", async () => {
  routes["GET /lms/api/settings/clientsettings"] = { body: { Messaging: { ParentsSchoolMessage: false, ParentsAbsenceMessage: false } } };
  for (const args of [
    { kind: "school", body: "Hello" },
    { kind: "absence", body: "Sick", absence_date: "2026-11-23" },
    { kind: "person", body: "Hi", contact_ids: [70] },
  ]) {
    const { isError, text } = await callTool("daymap_send_message", args);
    assert.equal(isError, true);
    assert.match(text, /doesn't/);
  }
  assert.deepEqual(writes(), []);
});

test("personal messages only go to people Daymap lists as contactable", async () => {
  routes["GET /lms/api/coms/messagecontactlist"] = {
    body: [{ Student: ALEX, CanMessageStudent: true, Teachers: [{ ContactID: 900 }], Leaders: [] }],
  };
  routes["POST /lms/api/coms/message/create"] = { body: { MessageID: 61, ThreadID: 61, MessageType: 10 } };
  routes["POST /lms/api/coms/draft/send"] = { body: { MessageID: 61 } };
  const refused = await callTool("daymap_send_message", { kind: "person", body: "Hi", contact_ids: [70, 12345] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /12345/);
  assert.deepEqual(writes(), []);
  assert.equal((await callTool("daymap_send_message", { kind: "person", body: "Hi", contact_ids: [70, 900] })).isError, false);
  assert.deepEqual(writes()[0].body, { body: "Hi", messageType: 10, contactIds: [70, 900] });
});

const FORM = {
  Form: {
    Items: [
      { FieldID: 1, Caption: "Comments", ControlType: 1 },
      { FieldID: 2, Caption: "Date", ControlType: 4 },
      { FieldID: 3, Caption: "Agree", ControlType: 6 },
      { FieldID: 4, Caption: "Pickup time", ControlType: 21 },
      { FieldID: 5, Caption: "Fee", ControlType: 23 },
    ],
  },
};

test("saving a form record keeps untouched fields and formats values like the portal", async () => {
  routes["GET /lms/api/forms/record"] = {
    body: {
      ...FORM,
      Record: {
        CanEdit: true,
        Results: { "1": { Value: "Old note" }, "2": { Value: "2026-11-01T00:00:00" }, "3": { Value: "False" } },
      },
    },
  };
  routes["POST /lms/api/forms/record/save"] = { body: { Record: { RowId: 77 } } };
  const result = await callTool("daymap_save_form_record", {
    form_id: 39,
    record_id: 77,
    action_id: 2,
    fields: [
      { field_id: 3, value: true },
      { field_id: 4, value: "2026-11-24T15:30:00" },
      { field_id: 1, value: "Pick up at 3:30 & thanks" },
    ],
  });
  assert.equal(result.isError, false, result.text);
  const read = mock.state.apiCalls.find((c) => c.path.startsWith("/lms/api/forms/record?"))!;
  assert.equal(read.path, "/lms/api/forms/record?formid=39&id=7&rowId=77&editMode=1&loadItems=true");
  const [save] = writes();
  assert.equal(save.path, "/lms/api/forms/record/save?formId=39&id=7&rowid=77&actionId=2&async=false");
  assert.deepEqual(save.body, [
    { FieldID: 1, Value: encodeURIComponent("Pick up at 3:30 & thanks") },
    { FieldID: 2, Value: "2026-11-01" },
    { FieldID: 3, Value: "True" },
    { FieldID: 4, Value: "2026-11-24T15:30" },
    { FieldID: 5, Value: "" },
  ]);
});

test("a new form record starts empty and is saved without a record ID", async () => {
  routes["GET /lms/api/forms/record"] = { body: { ...FORM, Record: { Results: { "1": { Value: "Template" } } } } };
  routes["POST /lms/api/forms/record/save"] = { body: { Record: { RowId: 78 } } };
  await callTool("daymap_save_form_record", { form_id: 39, fields: [{ field_id: 2, value: "2026-12-01" }] });
  assert.ok(mock.state.apiCalls.some((c) => c.path === "/lms/api/forms/record?formid=39&id=7&rowId=0&editMode=2&loadItems=true"));
  const [save] = writes();
  assert.equal(save.path, "/lms/api/forms/record/save?formId=39&id=7&async=false");
  assert.deepEqual(save.body.map((v: { Value: string }) => v.Value), ["", "2026-12-01", "", "", ""]);
});

test("payment and unknown form fields are refused, as are read-only records", async () => {
  routes["GET /lms/api/forms/record"] = { body: { ...FORM, Record: { CanEdit: true } } };
  const payment = await callTool("daymap_save_form_record", { form_id: 39, fields: [{ field_id: 5, value: "20" }] });
  assert.equal(payment.isError, true);
  assert.match(payment.text, /payment field/);
  const unknown = await callTool("daymap_save_form_record", { form_id: 39, fields: [{ field_id: 99, value: "x" }] });
  assert.match(unknown.text, /no field 99/);
  routes["GET /lms/api/forms/record"] = { body: { ...FORM, Record: { CanEdit: false } } };
  const locked = await callTool("daymap_save_form_record", { form_id: 39, record_id: 5, fields: [{ field_id: 1, value: "x" }] });
  assert.match(locked.text, /doesn't let you edit/);
  assert.deepEqual(writes(), []);
});

test("excursion consent is recorded against the excursion's project", async () => {
  routes["GET /lms/api/projects/excursions/event/300"] = { body: { ProjectId: 12, ConsentStatus: 0, ConsentRequired: true } };
  routes["POST /lms/api/projects/excursions/12/consent/7"] = { status: 204 };
  const { text, isError } = await callTool("daymap_excursion_consent", { event_id: 300, decision: "decline" });
  assert.equal(isError, false, text);
  assert.deepEqual(writes(), [{ method: "POST", path: "/lms/api/projects/excursions/12/consent/7", body: { Status: 2 } }]);
});

test("expired excursion consent can't be changed", async () => {
  routes["GET /lms/api/projects/excursions/event/300"] = { body: { ProjectId: 12, ConsentStatus: 3 } };
  const { text, isError } = await callTool("daymap_excursion_consent", { event_id: 300, decision: "give" });
  assert.equal(isError, true);
  assert.match(text, /expired/);
  assert.deepEqual(writes(), []);
});

test("interview booking checks the meeting method and sends the portal's query", async () => {
  routes["GET /lms/api/interviews/4"] = { body: { ParentOptions: ["In person", "Phone"] } };
  routes["POST /lms/api/interviews/4/slot/9/book"] = { status: 204 };
  const wrong = await callTool("daymap_book_interview", { group_id: 4, slot_id: 9, staff_id: 3, method: "Video" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /In person, Phone/);
  assert.deepEqual(writes(), []);
  const ok = await callTool("daymap_book_interview", { group_id: 4, slot_id: 9, staff_id: 3, method: "In person" });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(writes(), [
    { method: "POST", path: "/lms/api/interviews/4/slot/9/book?staffId=3&studentId=7&classId=0&method=In+person", body: undefined },
  ]);
});

test("cancelling an interview notifies by the school's chosen channel", async () => {
  routes["POST /lms/api/interviews/4/slot/9/cancel"] = { status: 204 };
  assert.equal((await callTool("daymap_cancel_interview", { group_id: 4, slot_id: 9, staff_id: 3 })).isError, false);
  assert.deepEqual(writes(), [{ method: "POST", path: "/lms/api/interviews/4/slot/9/cancel?staffId=3&sentVia=2", body: undefined }]);
});

test("the generic write tool refuses payments and passes other requests through", async () => {
  const payment = await callTool("daymap_api_request", { method: "POST", path: "/lms/api/payments/charge", body: { AgreedTotal: 10 } });
  const formSave = await callTool("daymap_api_request", {
    method: "POST",
    path: "/lms/api/x/..%2fforms/record/save?formId=39&id=7",
    body: [{ FieldID: 5, Value: "20" }],
  });
  assert.equal(formSave.isError, true);
  assert.match(formSave.text, /daymap_save_form_record/);
  assert.equal(payment.isError, true);
  assert.match(payment.text, /Payments can't be changed/);
  assert.deepEqual(writes(), []);
  routes["PATCH /lms/api/contact/profilesetting/DaymapTheme"] = { body: "ok" };
  const ok = await callTool("daymap_api_request", { method: "PATCH", path: "/lms/api/contact/profilesetting/DaymapTheme", body: "dark" });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(writes(), [{ method: "PATCH", path: "/lms/api/contact/profilesetting/DaymapTheme", body: "dark" }]);
});

test("every write tool is marked destructive and every read tool read-only", async () => {
  const { tools } = await client.listTools();
  const writeTools = new Set([
    "daymap_mark_messages_read",
    "daymap_archive_messages",
    "daymap_mark_notifications_read",
    "daymap_reply_to_message",
    "daymap_send_message",
    "daymap_save_form_record",
    "daymap_excursion_consent",
    "daymap_book_interview",
    "daymap_cancel_interview",
    "daymap_api_request",
  ]);
  for (const tool of tools) {
    if (writeTools.has(tool.name)) {
      assert.equal(tool.annotations?.destructiveHint, true, tool.name);
      assert.equal(tool.annotations?.readOnlyHint, false, tool.name);
    } else {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    }
  }
  assert.equal(tools.filter((t) => writeTools.has(t.name)).length, writeTools.size);
});
