import { test } from "node:test";
import assert from "node:assert/strict";
import { renderData, MAX_CHARS } from "../src/render.ts";

test("drops empty values and Daymap's no-date sentinel but keeps false and zero", () => {
  const out = renderData({
    ID: 1,
    Read: false,
    Count: 0,
    Notes: "",
    Recipients: null,
    Attachments: [],
    Properties: {},
    CreatedOn: "0001-01-01T00:00:00",
    SentOn: "2026-11-18T09:01:30.287",
  });
  assert.equal(out, "ID: 1\nRead: false\nCount: 0\nSentOn: 2026-11-18T09:01:30.287");
});

test("renders nested lists and objects as indented YAML", () => {
  const out = renderData([
    { Name: "Alex", Classes: [{ Code: "ENG08 E", Staff: { Name: "Pat" } }], Tags: ["a", "b"] },
  ]);
  assert.equal(
    out,
    [
      "- Name: Alex",
      "  Classes:",
      "    - Code: ENG08 E",
      "      Staff:",
      "        Name: Pat",
      "  Tags:",
      "    - a",
      "    - b",
    ].join("\n"),
  );
});

test("quotes strings that would otherwise read as another type or as YAML syntax", () => {
  const out = renderData({ Code: "8", Flag: "true", Subject: "Re: excursion", Leading: "- item", Plain: "8E" });
  assert.equal(
    out,
    'Code: "8"\nFlag: "true"\nSubject: "Re: excursion"\nLeading: "- item"\nPlain: 8E',
  );
});

test("turns HTML message bodies into Markdown and drops embedded base64 images", () => {
  const image = `<img alt="" src="data:image/png;base64,${"A".repeat(100_000)}">`;
  const out = renderData({
    Text: `<p>Bring <b>leather shoes</b> on Wednesday.</p>${image}<p>See <a href="https://x.test/a">this</a></p>`,
  });
  assert.equal(
    out,
    "Text: |\n  Bring **leather shoes** on Wednesday.\n\n  [image]\n\n  See [this](https://x.test/a)",
  );
});

test("leaves text that merely contains angle brackets alone", () => {
  assert.equal(renderData({ Note: "marks < 50 or > 90" }), "Note: marks < 50 or > 90");
});

test("decodes HTML entities in text without tags", () => {
  assert.equal(renderData({ Label: "Student&nbsp;Work &amp; notes" }), "Label: Student Work & notes");
});

test("caps very large responses and says so", () => {
  const out = renderData(Array.from({ length: 5000 }, (_, i) => ({ Index: i, Text: "x".repeat(40) })));
  assert.ok(out.length < MAX_CHARS + 200);
  assert.match(out, /…\[truncated \d+ characters/);
});

test("says when nothing came back", () => {
  assert.equal(renderData([]), "(no data)");
  assert.equal(renderData(null), "(no data)");
});
