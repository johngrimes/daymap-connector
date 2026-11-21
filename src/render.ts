import * as cheerio from "cheerio";
import TurndownService from "turndown";
// @ts-expect-error: no type declarations are published for this plugin.
import { gfm } from "turndown-plugin-gfm";

/** Tool output is capped so one response can't swamp the conversation. */
export const MAX_CHARS = 60_000;

/** .NET's DateTime.MinValue, which Daymap uses to mean "no date". */
const NO_DATE = /^0001-01-01T00:00:00(?:\.0+)?(?:Z|[+-]00:00)?$/;
const HTML_TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/i;
const HTML_ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);
const DROPPED_TAGS: Record<string, true> = { SCRIPT: true, STYLE: true, NOSCRIPT: true, IFRAME: true, SVG: true, CANVAS: true };
turndown.remove((node) => DROPPED_TAGS[node.nodeName.toUpperCase()] === true);
// Daymap embeds pasted images as megabytes of base64; keep only their alt text.
turndown.addRule("images", {
  filter: "img",
  replacement: (_content, node) => {
    const alt = (node as HTMLElement).getAttribute("alt")?.trim();
    return alt ? `[image: ${alt}]` : "[image]";
  },
});

/** Converts an HTML fragment (message bodies, notices, task descriptions) to Markdown. */
export function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(html)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Removes values that carry no information (null, empty strings, empty arrays and
 * objects, Daymap's "no date" sentinel) and turns HTML strings into Markdown.
 * Returns undefined when nothing is left.
 */
export function compact(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const text = HTML_TAG.test(value)
      ? htmlToMarkdown(value)
      : HTML_ENTITY.test(value)
        ? cheerio.load(value, null, false).text().replace(/\u00a0/g, " ")
        : value;
    return text.trim() === "" || NO_DATE.test(text) ? undefined : text;
  }
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, compact(v)] as const)
      .filter(([, v]) => v !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

function scalar(value: unknown): string {
  if (typeof value !== "string") return String(value);
  const ambiguous =
    value !== value.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /: |\s#/.test(value) ||
    /^(?:true|false|null|~|yes|no|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(value);
  return ambiguous ? JSON.stringify(value) : value;
}

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function lines(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isContainer(item)) {
        const [first = "", ...rest] = lines(item, `${indent}  `);
        return [`${indent}- ${first.slice(indent.length + 2)}`, ...rest];
      }
      return entry(`${indent}-`, item, indent);
    });
  }
  if (isContainer(value)) {
    return Object.entries(value).flatMap(([key, v]) => {
      if (isContainer(v)) return [`${indent}${key}:`, ...lines(v, `${indent}  `)];
      return entry(`${indent}${key}:`, v, indent);
    });
  }
  return [`${indent}${scalar(value)}`];
}

function entry(prefix: string, value: unknown, indent: string): string[] {
  if (typeof value === "string" && value.includes("\n")) {
    return [`${prefix} |`, ...value.split("\n").map((line) => (line ? `${indent}  ${line}` : ""))];
  }
  return [`${prefix} ${scalar(value)}`];
}

/** Renders a value as indented YAML-style text. */
export function toYaml(value: unknown): string {
  return lines(value, "").join("\n");
}

/** Caps text at MAX_CHARS, saying how much was cut. */
export function truncate(text: string): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n\n…[truncated ${text.length - MAX_CHARS} characters; ask for a smaller page or date range]`
    : text;
}

/** Renders an API response body compactly and losslessly (bar empty values) for Claude. */
export function renderData(data: unknown): string {
  const compacted = compact(data);
  if (compacted === undefined) return "(no data)";
  return truncate(toYaml(compacted));
}
