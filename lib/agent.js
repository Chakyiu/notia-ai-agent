// The turn: gather the open note and a few passages, then let the model
// call tools until it answers. A handful of rounds keeps a turn from running on.

import { complete } from "./provider.js";
import { searchNotes } from "./search.js";
import { DEFAULT_SYSTEM } from "./settings.js";
import { execute, toolList } from "./tools.js";

const ROUNDS = 6;
const HISTORY = 16;

export async function answer({ app, settings, history, question, attachment, notes, read, signal, onUpdate }) {
  const actions = [];
  const started = Date.now();
  const context = await gather(app, settings, question, read);
  if (attachment?.text) context.attachment = attachment;
  if (notes?.length) context.notes = notes;
  const tools = toolList(settings.allowEdits !== false);
  const messages = prior(history);
  messages.push({ role: "user", content: compose(question, context) });
  let preamble = "";
  let tokens = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    if (signal.stopped) return { stopped: true, actions, ms: Date.now() - started };
    const shown = (partial) => [preamble, partial].filter(Boolean).join("\n\n");
    onUpdate({
      working: round === 0 ? "Thinking…" : "Working…",
      text: shown(""),
      actions,
    });
    const reply = await complete(settings, systemText(settings), messages, tools, (partial) => {
      onUpdate({ working: "", text: shown(partial), actions });
    });
    tokens += reply.tokens || 0;
    if (signal.stopped) return { stopped: true, actions, ms: Date.now() - started };
    if (!reply.toolCalls.length) {
      const text = reply.text.trim() || preamble.trim() || "The model returned an empty reply.";
      return { text, actions, ms: Date.now() - started, tokens };
    }
    if (reply.text.trim()) preamble = preamble ? `${preamble}\n\n${reply.text.trim()}` : reply.text.trim();
    messages.push({ role: "assistant", content: reply.text || "", toolCalls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      if (signal.stopped) return { stopped: true, actions, ms: Date.now() - started };
      const result = await runCall(app, settings, call, read);
      if (result.action) actions.push(result.action);
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: result.output,
      });
      onUpdate({ working: "Working…", text: preamble, actions });
    }
  }
  return {
    text: preamble.trim() || "I stopped after several steps so this would not run on.",
    actions,
    ms: Date.now() - started,
    tokens,
  };
}

async function runCall(app, settings, call, read) {
  const result = execute(app, call);
  if (!result.pendingSearch) return result;
  let hits = [];
  try {
    hits = await searchNotes(app, settings, result.pendingSearch, read, 6);
  } catch (error) {
    return {
      output: error.message || String(error),
      action: { title: "Search failed", icon: "triangle-alert" },
    };
  }
  const output = hits.length
    ? hits.map((hit) => `${hit.path}\n${hit.text}`).join("\n\n")
    : "Nothing in the vault matched.";
  return {
    output,
    action: {
      title: `Searched “${result.pendingSearch}”`,
      icon: "search",
      detail: hits.length ? `${hits.length} passages` : "no matches",
      path: hits[0]?.path,
    },
  };
}

async function gather(app, settings, question, read) {
  const context = {};
  if (settings.includeNote !== false) {
    const note = app.workspace.getActiveNote();
    if (note) {
      const editor = app.workspace.getActiveEditor();
      const selection = editor?.getSelection?.() || "";
      context.note = {
        path: note.path,
        excerpt: excerpt(note),
        selection: selection.trim(),
      };
    }
  }
  if (settings.searchVault !== false) {
    try {
      context.hits = await searchNotes(app, settings, question, read, 4);
    } catch {
      context.hits = [];
    }
  }
  return context;
}

function excerpt(note) {
  const text = note.text || "";
  if (text.length <= 8000) return text;
  const lines = text.split("\n");
  const line = note.line || 0;
  return lines.slice(Math.max(0, line - 40), line + 40).join("\n").slice(0, 8000);
}

function compose(question, context) {
  const asked = String(question || "").trim();
  const labels = [
    context.attachment?.label,
    ...(context.notes || []).map((note) => note.label),
  ].filter(Boolean);
  const parts = [asked || (labels.length ? `Look at ${labels.join(", ")}.` : "")];
  if (context.attachment?.text) {
    parts.push(`The attached passage is ${context.attachment.path}:\n\n${context.attachment.text}`);
  }
  for (const note of context.notes || []) {
    if (note.text) parts.push(`The attached note is ${note.path}:\n\n${note.text}`);
  }
  const attached = new Set((context.notes || []).map((note) => note.path));
  if (context.note && !attached.has(context.note.path)) {
    parts.push(`The open note is ${context.note.path}.`);
    if (context.note.selection && context.note.selection !== context.attachment?.text) {
      parts.push(`The selection is:\n\n${context.note.selection}`);
    }
    if (context.note.excerpt) parts.push(`The note says:\n\n${context.note.excerpt}`);
  }
  if (context.hits?.length) {
    parts.push(
      `Passages from the vault:\n\n${context.hits.map((hit) => `${hit.path}\n${hit.text}`).join("\n\n")}`,
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

function prior(history) {
  return history
    .filter((turn) => (turn.role === "user" || turn.role === "assistant") && turnBody(turn) && !turn.error)
    .slice(-HISTORY)
    .map((turn) => ({ role: turn.role, content: turnBody(turn) }));
}

function turnBody(turn) {
  const parts = [];
  if (turn.text) parts.push(turn.text);
  if (turn.attachment?.text) {
    parts.push(`The attached passage is ${turn.attachment.path}:\n\n${turn.attachment.text}`);
  }
  for (const note of turn.notes || []) {
    if (note.text) parts.push(`The attached note is ${note.path}:\n\n${note.text}`);
  }
  return parts.join("\n\n");
}

function systemText(settings) {
  const base = String(settings.system || "").trim() || DEFAULT_SYSTEM;
  const policy =
    settings.allowEdits === false
      ? "Do not create or edit notes. Read them and answer."
      : "You may create notes and edit existing ones when asked. Do not change notes that were not asked about.";
  return `${base}\n\n${policy}`;
}
