// What the agent is allowed to do to the vault. There is no shell and no
// delete: a note changes only by a tool the model names.

const READ_LIMIT = 8000;

const PARAMETERS = {
  list_notes: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional text matched against the path and tags." },
    },
  },
  read_note: {
    type: "object",
    properties: { path: { type: "string", description: "Vault path, such as Folder/Note.md." } },
    required: ["path"],
  },
  search_notes: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  create_note: {
    type: "object",
    properties: {
      path: { type: "string" },
      text: { type: "string", description: "The full Markdown of the new note." },
    },
    required: ["path", "text"],
  },
  replace_in_note: {
    type: "object",
    properties: {
      path: { type: "string" },
      find: { type: "string", description: "Exact text to find. It must occur in the note." },
      replace: { type: "string" },
      all: { type: "boolean", description: "Replace every occurrence. Otherwise the first one." },
    },
    required: ["path", "find", "replace"],
  },
  append_note: {
    type: "object",
    properties: {
      path: { type: "string" },
      text: { type: "string" },
    },
    required: ["path", "text"],
  },
  insert_in_open_note: {
    type: "object",
    properties: { text: { type: "string", description: "Inserted at the cursor of the open note." } },
    required: ["text"],
  },
};

const TOOLS = [
  {
    name: "list_notes",
    description: "List notes in the vault. Optional query matches the path and tags.",
    writes: false,
  },
  {
    name: "read_note",
    description: "Read one note. Use the path from list_notes or search_notes.",
    writes: false,
  },
  {
    name: "search_notes",
    description: "Search note text. Uses the embedding index when one exists, and keywords otherwise.",
    writes: false,
  },
  {
    name: "create_note",
    description: "Create a new note. Fails if that path already exists.",
    writes: true,
  },
  {
    name: "replace_in_note",
    description: "Replace exact text in a note. Prefer this to rewriting the whole note.",
    writes: true,
  },
  {
    name: "append_note",
    description: "Add Markdown to the end of a note, creating the note if needed.",
    writes: true,
  },
  {
    name: "insert_in_open_note",
    description: "Insert text at the cursor of the note that is open.",
    writes: true,
  },
];

export function toolList(allowEdits) {
  return TOOLS.filter((tool) => allowEdits || !tool.writes).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: PARAMETERS[tool.name],
  }));
}

export function execute(app, call) {
  try {
    return run(app, call);
  } catch (error) {
    return {
      output: error.message || String(error),
      action: { title: `${call.name} failed`, icon: "triangle-alert" },
    };
  }
}

function run(app, call) {
  const args = call.arguments || {};
  switch (call.name) {
    case "list_notes":
      return listNotes(app, args.query);
    case "read_note":
      return readNote(app, args.path);
    case "search_notes":
      return { pendingSearch: String(args.query || ""), action: null };
    case "create_note":
      return createNote(app, args.path, args.text);
    case "replace_in_note":
      return replaceInNote(app, args.path, args.find, args.replace, Boolean(args.all));
    case "append_note":
      return appendNote(app, args.path, args.text);
    case "insert_in_open_note":
      return insertOpen(app, args.text);
    default:
      return { output: `Unknown tool ${call.name}.`, action: { title: "Unknown tool", icon: "triangle-alert" } };
  }
}

function listNotes(app, query) {
  const needle = String(query || "").trim().toLowerCase();
  let notes = app.vault.getNotes();
  if (needle) {
    notes = notes.filter((note) => `${note.path} ${note.tags.join(" ")}`.toLowerCase().includes(needle));
  }
  const shown = notes.slice(0, 100);
  const lines = shown.map((note) => (note.tags.length ? `${note.path}  #${note.tags.join(" #")}` : note.path));
  const more = notes.length > shown.length ? `\n${notes.length - shown.length} more notes were left out.` : "";
  return {
    output: lines.length ? `${lines.join("\n")}${more}` : "No notes matched.",
    action: {
      title: needle ? `Listed notes matching “${needle}”` : "Listed notes",
      icon: "file-text",
    },
  };
}

function readNote(app, path) {
  const found = readCurrent(app, path);
  if (found.error) return { output: found.error, action: { title: found.error, icon: "triangle-alert" } };
  let text = found.text;
  if (text.length > READ_LIMIT) {
    text = `${text.slice(0, READ_LIMIT)}\n\n[truncated]`;
  }
  return {
    output: text || "(empty note)",
    action: { title: `Read ${found.path}`, path: found.path, icon: "file-text" },
  };
}

function createNote(app, path, text) {
  const resolved = notePath(path);
  if (!resolved) return { output: "The path is empty.", action: { title: "Could not create a note", icon: "triangle-alert" } };
  if (app.vault.exists(resolved)) {
    return {
      output: `${resolved} already exists. Use replace_in_note or append_note.`,
      action: { title: `${resolved} already exists`, path: resolved, icon: "triangle-alert" },
    };
  }
  app.vault.create(resolved, String(text ?? ""));
  return {
    output: `Created ${resolved}.`,
    action: { title: `Created ${resolved}`, path: resolved, icon: "plus" },
  };
}

function replaceInNote(app, path, find, replace, all) {
  const found = readCurrent(app, path);
  if (found.error) return { output: found.error, action: { title: found.error, icon: "triangle-alert" } };
  const needle = String(find ?? "");
  if (!needle) return { output: "find is empty.", action: { title: "Nothing to replace", icon: "triangle-alert" } };
  const count = found.text.split(needle).length - 1;
  if (!count) {
    return {
      output: `That text is not in ${found.path}.`,
      action: { title: `No match in ${found.path}`, path: found.path, icon: "search" },
    };
  }
  const next = all ? found.text.split(needle).join(String(replace ?? "")) : found.text.replace(needle, String(replace ?? ""));
  writeCurrent(app, found, next);
  const places = all ? count : 1;
  return {
    output: `Replaced ${places} of ${count} in ${found.path}.`,
    action: { title: `Edited ${found.path}`, path: found.path, icon: "pencil", detail: `${places} replacement${places === 1 ? "" : "s"}` },
  };
}

function appendNote(app, path, text) {
  const resolved = notePath(path);
  if (!resolved) return { output: "The path is empty.", action: { title: "Could not append", icon: "triangle-alert" } };
  const addition = String(text ?? "");
  if (!app.vault.exists(resolved)) {
    app.vault.create(resolved, addition);
    return {
      output: `Created ${resolved}.`,
      action: { title: `Created ${resolved}`, path: resolved, icon: "plus" },
    };
  }
  const found = readCurrent(app, resolved);
  let next = found.text;
  if (next && !next.endsWith("\n")) next += "\n";
  next += addition.startsWith("\n") || !next ? addition : `\n${addition}`;
  writeCurrent(app, found, next);
  return {
    output: `Appended to ${resolved}.`,
    action: { title: `Appended to ${resolved}`, path: resolved, icon: "pencil" },
  };
}

function insertOpen(app, text) {
  const note = app.workspace.getActiveNote();
  if (!note) return { output: "No note is open.", action: { title: "No note is open", icon: "triangle-alert" } };
  app.workspace.insertText(String(text ?? ""));
  return {
    output: `Inserted text into ${note.path}.`,
    action: { title: `Edited ${note.path}`, path: note.path, icon: "pencil", detail: "at the cursor" },
  };
}

function notePath(path) {
  let value = String(path || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || value.split("/").includes("..")) return null;
  if (!/\.[A-Za-z0-9]+$/.test(value)) value += ".md";
  return value;
}

function samePath(left, right) {
  return notePath(left) === notePath(right);
}

/** The open note's editor when it is the note at `path`, so unsaved edits count. */
function readCurrent(app, path) {
  const resolved = notePath(path);
  if (!resolved) return { error: "The path is empty." };
  const active = app.workspace.getActiveNote();
  if (active && samePath(active.path, resolved)) {
    const editor = app.workspace.getActiveEditor();
    if (editor) return { path: active.path, text: editor.getValue(), editor };
  }
  if (!app.vault.exists(resolved)) return { error: `There is no note ${resolved}.` };
  return { path: resolved, text: app.vault.read(resolved), editor: null };
}

function writeCurrent(app, found, text) {
  if (found.editor) {
    found.editor.setValue(text);
    return;
  }
  app.vault.modify(found.path, text);
}

export { readCurrent };
