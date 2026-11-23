// Continuations for the open note. The editor cannot draw ghost text, so a
// suggestion stays here until a command inserts it.

import { inlineMaxChars } from "./settings.js";

const SYSTEM = [
  "You continue a Markdown note in the same voice.",
  "Reply with only the text to insert.",
  "Do not repeat text that is already before the cursor.",
  "Do not wrap the reply in quotes or a code fence.",
  "If a space belongs before the insertion, include that space.",
  "Stop at a natural break.",
].join(" ");

/** The user message for one continuation. `maxChars` is already clamped. */
export function continuationPrompt({ before, after, selection, maxChars }) {
  const limit = inlineMaxChars({ inlineMaxChars: maxChars });
  const selected = String(selection || "");
  const parts = [`Write at most ${limit} characters.`];
  if (selected) {
    parts.push("A selection is active. Reply with the text that should replace it.");
    parts.push(`Selection:\n${clip(selected, 4000)}`);
  } else {
    parts.push("Nothing is selected. Reply with the text to insert at the cursor.");
  }
  parts.push(`Before the cursor:\n${clipEnd(before, 6000)}`);
  parts.push(`After the cursor:\n${clip(after, 2000)}`);
  return parts.join("\n\n");
}

/**
 * One completion, then only the characters worth inserting.
 * `complete` is the chat completion used by the rest of the plugin.
 */
export async function writeContinuation({ complete, settings, before, after, selection, maxChars, signal, onDelta }) {
  if (signal?.stopped) return "";
  const limit = inlineMaxChars({ inlineMaxChars: maxChars });
  const reply = await complete(
    settings,
    SYSTEM,
    [{ role: "user", content: continuationPrompt({ before, after, selection, maxChars: limit }) }],
    [],
    (partial) => {
      if (signal?.stopped || !onDelta || String(partial).includes("```")) return;
      const preview = normalizeSuggestion(partial, limit, before);
      if (preview) onDelta(preview);
    },
    { maxTokens: Math.max(32, Math.ceil(limit / 3)) },
  );
  if (signal?.stopped) return "";
  return normalizeSuggestion(reply?.text || "", limit, before);
}

/** Drops fences and a repeated last line, then keeps at most `maxChars`. */
export function normalizeSuggestion(raw, maxChars, before = "") {
  let text = unwrapFence(String(raw || "").replace(/\r\n/g, "\n").trim());
  const lastLine = String(before || "").split("\n").pop() || "";
  if (lastLine.length >= 12 && text.startsWith(lastLine)) text = text.slice(lastLine.length);
  text = text.replace(/^\n+/, "").replace(/[ \t]+$/g, "").replace(/\n+$/g, "");
  text = clipChars(text, inlineMaxChars({ inlineMaxChars: maxChars }));
  return text.trim() ? text : "";
}

/** Cursor position after inserting `text` at `from`. Columns are UTF-16 indexes. */
export function positionAfter(from, text) {
  const lines = String(text || "").split("\n");
  if (lines.length === 1) return { line: from.line, ch: from.ch + lines[0].length };
  return { line: from.line + lines.length - 1, ch: lines[lines.length - 1].length };
}

/** True when the caret and the surrounding text are still where the suggestion was made. */
export function suggestionMatches(pending, snapshot) {
  if (!pending?.text || !snapshot) return false;
  if (pending.path !== snapshot.path) return false;
  if (pending.line !== snapshot.line || pending.ch !== snapshot.ch) return false;
  if ((pending.selection || "") !== (snapshot.selection || "")) return false;
  return String(snapshot.before || "").endsWith(pending.beforeTail || "");
}

/** Identity of the caret a request was made for. */
export function anchorKey(snapshot) {
  const selected = snapshot.selection || "";
  return [
    snapshot.path,
    snapshot.line,
    snapshot.ch,
    selected.length,
    selected.slice(0, 40),
    String(snapshot.before || "").slice(-80),
  ].join("\n");
}

/** One line for the status bar. */
export function statusPreview(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line;
  return `${line.slice(0, 47)}…`;
}

function unwrapFence(text) {
  const fenced = text.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : text;
}

function clip(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function clipEnd(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

function clipChars(text, limit) {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const br = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return br >= Math.floor(limit * 0.6) ? cut.slice(0, br).trimEnd() : cut.trimEnd();
}
