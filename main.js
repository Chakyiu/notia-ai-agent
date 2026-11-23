import api from "notia";

import { answer } from "./lib/agent.js";
import {
  anchorKey,
  positionAfter,
  statusPreview,
  suggestionMatches,
  writeContinuation,
} from "./lib/inline.js";
import { complete, listModels } from "./lib/provider.js";
import { clearIndex, indexSummary, indexVault } from "./lib/search.js";
import {
  PROVIDERS,
  chatEndpoint,
  chatError,
  defaults,
  embedEndpoint,
  embeddingProviderChoices,
  inlineDebounceMs,
  inlineMaxChars,
  modelChoices,
  providerChoices,
} from "./lib/settings.js";

const { Plugin, Notice, ui } = api;

/** How long the vault has to stay quiet before an index pass, in ms. */
const INDEX_DELAY_MS = 2000;
const EMBEDDING_KEYS = ["embeddingProvider", "embeddingModel", "embeddingBase", "embeddingKey"];

export default class Agent extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.settings = { ...defaults(), ...(saved && typeof saved === "object" ? saved : {}) };
    const stored = loadSessions(this.readFile("sessions.json"));
    this.sessions = stored.sessions.length ? stored.sessions : [blankSession()];
    if (!this.sessions.some((session) => session.open)) this.sessions.push(blankSession());
    const open = this.sessions.find((session) => session.id === stored.activeId && session.open);
    this.activeId = (open || this.sessions.find((session) => session.open)).id;
    this.historyOpen = false;
    this.working = null;
    this.workingId = null;
    this.streamText = "";
    this.pendingActions = [];
    this.generation = 0;
    this.signal = { stopped: false };
    this.indexing = null;
    this.indexTimer = null;
    this.indexPassOwed = false;
    this.activity = "";
    this.suggestion = null;
    this.flight = null;
    this.inlineTimer = null;
    this.inlineStatusText = "";
    this.contextSignatureValue = "";

    this.panel = this.addPanel({
      id: "chat",
      title: "Agent",
      icon: "bot",
      side: "right",
      render: () => this.renderChat(),
    });
    this.addPanel({
      id: "ask",
      title: "Agent",
      icon: "sparkles",
      side: "editor",
      render: () =>
        ui.button("", () => this.panel.show(), {
          icon: "sparkles",
          variant: "ghost",
          tooltip: "Agent",
        }),
    });
    this.tab = this.addSettingTab({
      icon: "bot",
      render: () => this.renderSettings(),
    });

    this.addRibbonIcon("bot", "Agent", () => this.panel.show());
    this.inlineStatus = this.addStatusBarItem();
    this.registerInterval(setInterval(() => {
      if (this.workingId) this.panel.refresh();
      this.followEditor();
    }, 1000));
    this.addCommand({
      id: "show",
      name: "Show the agent",
      icon: "bot",
      hotkey: "secondary-shift-a",
      callback: () => this.panel.show(),
    });
    this.addCommand({
      id: "new-chat",
      name: "New agent chat",
      icon: "plus",
      callback: () => {
        this.newChat();
        this.panel.show();
      },
    });
    this.addCommand({
      id: "ask-selection",
      name: "Ask the agent about the selection",
      icon: "sparkles",
      editorCallback: (editor, note) => {
        if (!this.attachSelection(editor, note)) return;
        this.panel.show();
      },
    });
    this.addCommand({
      id: "continue-writing",
      name: "Continue writing",
      icon: "sparkles",
      hotkey: "alt-\\",
      editorCallback: (editor, note) => this.continueWriting(editor, note),
    });
    this.addCommand({
      id: "dismiss-suggestion",
      name: "Dismiss the writing suggestion",
      icon: "x",
      hotkey: "alt-shift-\\",
      callback: () => this.dismissSuggestion(),
    });
    this.addCommand({
      id: "index",
      name: "Index notes for the agent",
      icon: "refresh-cw",
      callback: () => this.startIndex(),
    });

    for (const event of ["modify", "rename", "delete"]) {
      this.registerEvent(this.app.vault.on(event, () => this.scheduleIndex()));
    }
    this.registerEvent(this.app.workspace.on("editor-change", () => this.onEditorChange()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.onFileOpen()));
    this.contextSignatureValue = this.contextSignature();
    if (this.settings.indexRefresh === "change" && embedEndpoint(this.settings)) {
      this.startIndex({ auto: true });
    }

    if (typeof api.requestUrl !== "function") {
      new Notice("This Notia is too old for the agent. Update Notia and try again.");
    }
  }

  onunload() {
    if (this.indexTimer != null) clearTimeout(this.indexTimer);
    this.indexTimer = null;
    this.clearInlineTimer();
    this.cancelInline();
  }

  // shortcut: status-bar preview instead of ghost text, until the editor can show uncommitted inline text
  setInlineStatus(text) {
    const next = String(text || "");
    if (this.inlineStatusText === next) return;
    this.inlineStatusText = next;
    this.inlineStatus?.setText(next);
  }

  clearInlineTimer() {
    if (this.inlineTimer != null) clearTimeout(this.inlineTimer);
    this.inlineTimer = null;
  }

  cancelInline() {
    if (this.flight) this.flight.signal.stopped = true;
    this.flight = null;
  }

  dismissSuggestion() {
    this.clearInlineTimer();
    this.cancelInline();
    this.suggestion = null;
    this.setInlineStatus("");
  }

  onFileOpen() {
    this.dismissSuggestion();
    this.syncContextChips();
  }

  onEditorChange() {
    if (this.flight) this.flight.signal.stopped = true;
    if (this.suggestion || this.flight) {
      this.suggestion = null;
      this.setInlineStatus("");
    }
    this.syncContextChips();
    this.scheduleInline();
  }

  // shortcut: poll the caret to drop a stale suggestion, until workspace emits cursor moves
  followEditor() {
    if (this.flight || this.suggestion) {
      const snapshot = takeSnapshot(this.app.workspace.getActiveEditor(), this.app.workspace.getActiveNote());
      if (this.flight && (!snapshot || this.flight.key !== anchorKey(snapshot))) {
        this.flight.signal.stopped = true;
        this.setInlineStatus("");
      }
      if (this.suggestion && !suggestionMatches(this.suggestion, snapshot)) {
        this.suggestion = null;
        if (!this.flight || this.flight.signal.stopped) this.setInlineStatus("");
      }
    }
    this.syncContextChips();
  }

  scheduleInline() {
    this.clearInlineTimer();
    if (this.settings.inlineAssist === false || this.workingId) return;
    const note = this.app.workspace.getActiveNote();
    if (!note || note.mode === "preview") return;
    this.inlineTimer = setTimeout(() => {
      this.inlineTimer = null;
      this.prepareSuggestion(this.app.workspace.getActiveEditor(), this.app.workspace.getActiveNote(), {
        insert: false,
      });
    }, inlineDebounceMs(this.settings));
  }

  continueWriting(editor, note) {
    const snapshot = takeSnapshot(editor, note);
    if (this.suggestion && suggestionMatches(this.suggestion, snapshot)) {
      this.applySuggestion(editor, this.suggestion);
      return;
    }
    this.prepareSuggestion(editor, note, { insert: true });
  }

  async prepareSuggestion(editor, note, { insert }) {
    const snapshot = takeSnapshot(editor, note);
    if (!snapshot) return;
    if (!insert && (snapshot.mode === "preview" || snapshot.selection || snapshot.before.trim().length < 8)) return;
    const problem = chatError(this.settings);
    if (problem) {
      if (insert) new Notice(`${problem} Settings → AI agent.`);
      return;
    }
    const key = anchorKey(snapshot);
    if (this.flight && !this.flight.signal.stopped && this.flight.key === key) {
      if (insert) {
        this.flight.insert = true;
        this.setInlineStatus("Writing…");
      }
      return;
    }
    if (this.flight) this.flight.signal.stopped = true;
    const signal = { stopped: false };
    const flight = { key, insert, signal };
    this.flight = flight;
    this.setInlineStatus(insert ? "Writing…" : "Suggesting…");
    try {
      const text = await writeContinuation({
        complete,
        settings: this.settings,
        before: snapshot.before,
        after: snapshot.after,
        selection: snapshot.selection,
        maxChars: inlineMaxChars(this.settings),
        signal,
        onDelta: (preview) => {
          if (signal.stopped || this.flight !== flight) return;
          const label = flight.insert ? "Writing…" : "Alt+\\";
          this.setInlineStatus(`${label} ${statusPreview(preview)}`);
        },
      });
      if (signal.stopped || this.flight !== flight) return;
      const pending = {
        path: snapshot.path,
        line: snapshot.line,
        ch: snapshot.ch,
        selection: snapshot.selection,
        beforeTail: snapshot.before.slice(-80),
        text,
      };
      const current = takeSnapshot(this.app.workspace.getActiveEditor(), this.app.workspace.getActiveNote());
      if (!text || !suggestionMatches(pending, current)) {
        this.setInlineStatus("");
        if (flight.insert) {
          new Notice(text ? "The note changed before the suggestion was ready." : "The model returned nothing to insert.");
        }
        return;
      }
      if (flight.insert) {
        this.applySuggestion(this.app.workspace.getActiveEditor(), pending);
        return;
      }
      this.suggestion = pending;
      this.setInlineStatus(`Alt+\\ ${statusPreview(text)}`);
    } catch (error) {
      if (signal.stopped || this.flight !== flight) return;
      this.setInlineStatus("");
      if (flight.insert) new Notice(error.message || String(error));
    } finally {
      if (this.flight === flight) this.flight = null;
    }
  }

  applySuggestion(editor, pending) {
    this.suggestion = null;
    this.setInlineStatus("");
    try {
      if (pending.selection) {
        editor.transaction({ replaceSelection: pending.text });
      } else {
        const from = { line: pending.line, ch: pending.ch };
        editor.transaction({
          changes: [{ from, text: pending.text }],
          selection: { from: positionAfter(from, pending.text) },
        });
      }
    } catch (error) {
      new Notice(error.message || String(error));
    }
  }

  /** One index pass ~2s after the vault settled, while the setting is on. */
  scheduleIndex() {
    if (this.settings.indexRefresh !== "change") return;
    if (this.indexTimer != null) clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      // A pass already running would ignore this one, so owe it instead.
      if (this.indexing) {
        this.indexPassOwed = true;
        return;
      }
      this.startIndex({ auto: true });
    }, INDEX_DELAY_MS);
  }

  renderChat() {
    const session = this.chat();
    const body = this.historyOpen
      ? flatten([this.renderHistory(), this.renderMessages(session)])
      : this.renderMessages(session);
    return ui.dock(body, this.renderComposer(session), this.renderTabBar());
  }

  renderTabBar() {
    const tabs = this.sessions
      .filter((session) => session.open)
      .map((session) => ({
        label: session.title,
        icon: "message-square",
        active: session.id === this.activeId,
        onSelect: () => this.selectSession(session.id),
        onClose: () => this.closeSession(session.id),
      }));
    return ui.tabBar(tabs, [
      ui.button("", () => this.newChat(), { icon: "plus", variant: "ghost", tooltip: "New chat" }),
      ui.button("", () => this.toggleHistory(), {
        icon: "clock",
        variant: "ghost",
        tooltip: this.historyOpen ? "Close history" : "History",
      }),
    ]);
  }

  renderHistory() {
    const items = this.sessions
      .filter((session) => session.messages.length)
      .sort((a, b) => b.updated - a.updated);
    if (!items.length) return [ui.empty("No earlier chats.")];
    return [
      ui.heading("History"),
      ui.list(
        items.map((session) => ({
          title: session.title,
          subtitle: sessionStamp(session.updated),
          icon: session.id === this.activeId ? "sparkles" : "message-square",
          onClick: () => this.selectSession(session.id),
        })),
      ),
    ];
  }

  renderMessages(session) {
    const messages = session.messages.length
      ? flatten(session.messages.map((message) => this.renderMessage(message)))
      : [ui.empty("Ask anything about your notes.")];
    if (this.workingId === session.id) {
      if (this.streamText) {
        messages.push(ui.text("Agent", { small: true, muted: true, bold: true }));
        messages.push(ui.markdown(this.streamText));
      }
      if (this.pendingActions.length) {
        messages.push(ui.list(this.actionItems(this.pendingActions), { compact: true }));
      }
    }
    return messages;
  }

  renderStatus(session) {
    const live = this.workingId === session.id;
    const done = !live && session.result;
    if (!live && !done) return null;
    const ms = live ? Date.now() - (this.started || Date.now()) : session.result.ms;
    const seconds = Math.max(1, Math.round(ms / 1000));
    const parts = [
      ui.icon(live ? "circle" : "check", { muted: live }),
      ui.text(live ? this.working || "Working" : "Done", { small: true }),
      ui.text(`${seconds}s`, { small: true, muted: true }),
    ];
    if (done && session.result.tokens > 0 && ms > 0) {
      const rate = Math.max(1, Math.round(session.result.tokens / (ms / 1000)));
      parts.push(ui.text(`${rate} tok/s`, { small: true, muted: true }));
    }
    return ui.row(
      [
        ui.row(parts, { wrap: false }),
        live
          ? ui.button("", () => this.stop(), { icon: "square", variant: "ghost", tooltip: "Stop" })
          : null,
      ],
      { spread: true, wrap: false },
    );
  }

  renderComposer(session) {
    const chat = chatEndpoint(this.settings);
    const model = chat.model || chat.provider.label;
    return [
      this.renderStatus(session),
      this.settings.searchVault ? ui.text(this.searchStatus(), { small: true, muted: true }) : null,
      ui.composer([
        this.renderAttachments(session),
        this.renderMention(session),
        ui.textArea(session.draft, (draft) => {
          const before = mentionQuery(session.draft);
          session.draft = draft;
          const closed = String(draft).match(/\[\[([^\]\n]+)\]\]$/);
          if (closed) {
            const wanted = closed[1].trim().toLowerCase();
            const match = this.mentionNotes(closed[1]).find(
              (note) => note.name.toLowerCase() === wanted || String(note.path).toLowerCase() === wanted,
            );
            if (match) {
              this.attachNote(match.path);
              return;
            }
          }
          if (before !== mentionQuery(draft)) this.panel.refresh();
        }, {
          id: "composer",
          rows: 1,
          maxRows: 7,
          plain: true,
          placeholder: "Ask anything, [[ to add a note",
          onSubmit: (text) => this.commitDraft(session, text),
        }),
        ui.row(
          [
            ui.text(model, { small: true, muted: true }),
            ui.row(
              [
                ui.button("", () => this.attachSelection(), {
                  icon: "paperclip",
                  variant: "ghost",
                  tooltip: "Add the selection",
                }),
                ui.button("", () => this.commitDraft(session), {
                  icon: "arrow-up",
                  variant: "primary",
                  tooltip: "Send",
                }),
              ],
              { wrap: false },
            ),
          ],
          { spread: true, wrap: false },
        ),
      ]),
    ];
  }

  renderMessage(message) {
    if (message.role === "user") {
      const blocks = [ui.text("You", { small: true, muted: true, bold: true })];
      if (message.attachment) blocks.push(ui.chip(message.attachment.label));
      for (const note of message.notes || []) blocks.push(ui.chip(note.label));
      if (message.text) blocks.push(ui.markdown(message.text));
      return blocks;
    }
    const blocks = [ui.text("Agent", { small: true, muted: true, bold: true })];
    if (message.error) blocks.push(ui.text(message.text, { danger: true }));
    else if (message.text) blocks.push(ui.markdown(message.text));
    if (message.actions?.length) {
      blocks.push(ui.list(this.actionItems(message.actions), { compact: true }));
    }
    if (message.ms) blocks.push(ui.text(worked(message), { small: true, muted: true }));
    return blocks;
  }

  actionItems(actions) {
    return actions.map((action) => ({
      title: action.title,
      subtitle: action.detail,
      icon: action.icon,
      onClick: action.path ? () => this.app.workspace.openNote(action.path) : undefined,
    }));
  }

  chat() {
    return (
      this.sessions.find((session) => session.id === this.activeId) ||
      this.sessions.find((session) => session.open) ||
      this.sessions[0]
    );
  }

  newChat() {
    const current = this.chat();
    if (current && !current.messages.length && !current.draft && !current.context && !current.notes?.length) {
      current.open = true;
      this.activeId = current.id;
      this.historyOpen = false;
      this.panel.refresh();
      return;
    }
    const session = blankSession();
    this.sessions.push(session);
    this.activeId = session.id;
    this.historyOpen = false;
    this.persistSessions();
    this.panel.refresh();
  }

  selectSession(id) {
    const session = this.sessions.find((item) => item.id === id);
    if (!session) return;
    session.open = true;
    this.activeId = id;
    this.historyOpen = false;
    this.persistSessions();
    this.panel.refresh();
  }

  closeSession(id) {
    const session = this.sessions.find((item) => item.id === id);
    if (!session) return;
    const empty = !session.messages.length && !session.draft && !session.context && !session.notes?.length;
    if (empty) this.sessions = this.sessions.filter((item) => item.id !== id);
    else session.open = false;
    if (this.activeId === id) {
      const open = this.sessions.filter((item) => item.open);
      if (!open.length) {
        const fresh = blankSession();
        this.sessions.push(fresh);
        this.activeId = fresh.id;
      } else {
        this.activeId = open[open.length - 1].id;
      }
    }
    this.persistSessions();
    this.panel.refresh();
  }

  toggleHistory() {
    this.historyOpen = !this.historyOpen;
    this.panel.refresh();
  }

  persistSessions() {
    this.sessions = trimSessions(this.sessions);
    this.writeFile(
      "sessions.json",
      JSON.stringify({ activeId: this.activeId, sessions: this.sessions }),
    );
  }

  /** Adds the selected lines to the chat, shown as the file and the line numbers. */
  attachSelection(editor, note) {
    const open = note || this.app.workspace.getActiveNote();
    const writing = editor || this.app.workspace.getActiveEditor();
    const selected = writing?.somethingSelected?.() ? writing.getSelection().trim() : "";
    if (!writing || !open || !selected) {
      new Notice("Select some text in a note first.");
      return false;
    }
    const from = writing.getCursor("from");
    const to = writing.getCursor("to");
    let end = to.line;
    if (to.ch === 0 && end > from.line) end -= 1;
    const file = String(open.path).split("/").pop();
    const start = from.line + 1;
    const last = end + 1;
    this.chat().context = {
      path: open.path,
      label: start === last ? `${file} (${start})` : `${file} (${start}-${last})`,
      text: selected,
    };
    this.panel.refresh();
    return true;
  }

  renderAttachments(session) {
    const chips = this.contextChips(session).map((chip) => ui.chip(chip.label, chip.dismiss));
    if (session.context) {
      chips.push(
        ui.chip(session.context.label, () => {
          session.context = null;
          this.panel.refresh();
        }),
      );
    }
    for (const note of session.notes || []) {
      chips.push(
        ui.chip(note.label, () => {
          session.notes = session.notes.filter((item) => item.path !== note.path);
          this.persistSessions();
          this.panel.refresh();
        }),
      );
    }
    return chips.length ? ui.row(chips, { wrap: true }) : null;
  }

  /** Open note and live selection, which the next message includes unless dismissed. */
  contextChips(session) {
    if (this.settings.includeNote === false) return [];
    const note = this.app.workspace.getActiveNote();
    const editor = this.app.workspace.getActiveEditor();
    if (!note || !editor) return [];
    const chips = [];
    const file = String(note.path).split("/").pop();
    const pinnedNote = (session.notes || []).some((item) => item.path === note.path);
    if (!pinnedNote && session.omitNote !== note.path) {
      chips.push({
        label: `Open · ${file}`,
        dismiss: () => {
          session.omitNote = note.path;
          this.persistSessions();
          this.syncContextChips();
        },
      });
    }
    let selected = "";
    try {
      selected = editor.somethingSelected() ? editor.getSelection().trim() : "";
    } catch {
      selected = "";
    }
    const pinned = String(session.context?.text || "").trim();
    if (selected && selected !== pinned && session.omitNote !== note.path && session.omitSelection !== selected) {
      chips.push({
        label: `Selection · ${selectionChipLabel(editor, note)}`,
        dismiss: () => {
          session.omitSelection = selected;
          this.persistSessions();
          this.syncContextChips();
        },
      });
    }
    return chips;
  }

  contextSignature() {
    try {
      const note = this.app.workspace.getActiveNote();
      const editor = this.app.workspace.getActiveEditor();
      const selected = editor?.somethingSelected?.() ? editor.getSelection().trim() : "";
      const labels = this.contextChips(this.chat()).map((chip) => chip.label).join("|");
      return `${note?.path || ""}\n${selected.length}\n${selected.slice(0, 24)}\n${labels}`;
    } catch {
      return "";
    }
  }

  syncContextChips() {
    const next = this.contextSignature();
    if (next === this.contextSignatureValue) return;
    this.contextSignatureValue = next;
    this.panel?.refresh();
  }

  /** Notes matching the `[[` link being typed at the end of the draft. */
  renderMention(session) {
    const query = mentionQuery(session.draft);
    if (query === null) return null;
    const notes = this.mentionNotes(query);
    if (!notes.length) return ui.text("No notes match.", { small: true, muted: true });
    return ui.list(
      notes.map((note) => ({
        title: note.name,
        icon: "file-text",
        onClick: () => this.attachNote(note.path),
      })),
      { compact: true },
    );
  }

  mentionNotes(query) {
    const q = String(query || "").trim().toLowerCase();
    return this.app.vault
      .getNotes()
      .map((note) => ({ note, score: noteScore(note, q) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path))
      .slice(0, 8)
      .map((item) => item.note);
  }

  /** Enter or Send attaches the highlighted note while `[[` is being typed. */
  commitDraft(session, text) {
    const draft = text ?? session.draft;
    const query = mentionQuery(draft);
    if (query !== null) {
      const [match] = this.mentionNotes(query);
      if (match) {
        session.draft = draft;
        this.attachNote(match.path);
        return;
      }
    }
    this.submit(draft);
  }

  /** Adds a whole note to the chat, shown as its file name. */
  attachNote(path) {
    const session = this.chat();
    const notes = session.notes || [];
    session.draft = String(session.draft || "").replace(/\[\[[^\]\n]*(?:\]\])?$/, "");
    if (notes.some((item) => item.path === path)) {
      session.notes = notes;
      this.panel.refresh();
      return;
    }
    if (notes.length >= 5) {
      new Notice("This chat already has 5 notes.");
      this.panel.refresh();
      return;
    }
    let text = "";
    try {
      const active = this.app.workspace.getActiveNote();
      text = active && active.path === path ? active.text : this.app.vault.read(path);
    } catch (error) {
      new Notice(error.message || "Could not read that note.");
      this.panel.refresh();
      return;
    }
    notes.push({ path, label: String(path).split("/").pop(), text: clipNote(text) });
    session.notes = notes;
    this.persistSessions();
    this.panel.refresh();
  }

  stop() {
    if (!this.workingId) return;
    this.generation += 1;
    this.signal.stopped = true;
    const actions = this.pendingActions;
    const session = this.sessions.find((item) => item.id === this.workingId) || this.chat();
    this.pendingActions = [];
    const partial = this.streamText;
    this.streamText = "";
    this.working = null;
    this.workingId = null;
    session.messages.push({
      role: "assistant",
      text: partial ? `${partial}\n\nStopped.` : "Stopped.",
      actions,
      ms: Date.now() - (this.started || Date.now()),
    });
    session.updated = Date.now();
    this.persistSessions();
    this.panel.refresh();
  }

  async submit(text) {
    const session = this.chat();
    const question = String(text ?? "").trim();
    const attachment = session.context;
    const notes = session.notes || [];
    const omitNote = session.omitNote || "";
    const omitSelection = session.omitSelection || "";
    if (!question && !attachment && !notes.length) return;
    if (this.workingId) {
      new Notice(
        this.workingId === session.id
          ? "This chat is still replying. Stop it to send again."
          : "The other chat is still replying.",
      );
      this.panel.refresh();
      return;
    }
    const problem = chatError(this.settings);
    if (!session.messages.some((message) => message.role === "user")) {
      session.title = chatTitle(question, attachment, notes);
    }
    session.draft = "";
    session.context = null;
    session.notes = [];
    session.omitNote = "";
    session.omitSelection = "";
    session.updated = Date.now();
    session.messages.push({ role: "user", text: question, attachment, notes });
    session.result = null;
    this.historyOpen = false;
    this.persistSessions();
    if (problem) {
      session.messages.push({ role: "assistant", text: `${problem} Settings → AI agent.`, error: true });
      this.panel.refresh();
      return;
    }
    const sessionId = session.id;
    const generation = ++this.generation;
    this.signal = { stopped: false };
    const signal = this.signal;
    this.working = "Thinking…";
    this.workingId = sessionId;
    this.streamText = "";
    this.pendingActions = [];
    this.started = Date.now();
    this.panel.refresh();
    const history = session.messages.slice(0, -1);
    const finish = (message) => {
      const target = this.sessions.find((item) => item.id === sessionId);
      if (!target) return;
      target.messages.push(message);
      target.updated = Date.now();
      this.persistSessions();
    };
    try {
      const result = await answer({
        app: this.app,
        settings: this.settings,
        history,
        question,
        attachment,
        notes,
        omitNote,
        omitSelection,
        read: (name) => this.readFile(name),
        signal,
        onUpdate: (update) => {
          if (generation !== this.generation) return;
          this.streamText = update.text || "";
          this.working = update.working || null;
          this.pendingActions = update.actions;
          this.panel.refresh();
        },
      });
      if (generation !== this.generation || result.stopped) return;
      const target = this.sessions.find((item) => item.id === sessionId);
      if (target) target.result = { ms: result.ms, tokens: result.tokens || 0 };
      finish({ role: "assistant", text: result.text, actions: result.actions, ms: result.ms });
    } catch (error) {
      if (generation !== this.generation) return;
      finish({ role: "assistant", text: error.message || String(error), error: true });
    } finally {
      if (generation === this.generation) {
        this.working = null;
        this.workingId = null;
        this.streamText = "";
        this.pendingActions = [];
        this.panel.refresh();
      }
    }
  }

  renderSettings() {
    const chat = chatEndpoint(this.settings);
    const choices = modelChoices(this.settings, chat.provider.id, "chat");
    const embedId = this.settings.embeddingProvider === "same" ? this.settings.chatProvider : this.settings.embeddingProvider;
    const embedProvider = PROVIDERS[embedId];
    const embedChoices =
      embedProvider?.embed && this.settings.embeddingProvider !== "none"
        ? modelChoices(this.settings, embedId, "embed")
        : [];
    const embed = embedEndpoint(this.settings);
    const rows = [
      ui.text("The agent sits in the right sidebar. A sparkles button above the note opens it. Alt+\\ continues the note."),
      ui.heading("Chat"),
      ui.setting(
        "Provider",
        ui.dropdown(this.settings.chatProvider, providerChoices(), (chatProvider) => {
          const next = PROVIDERS[chatProvider] ?? PROVIDERS.openai;
          const patch = { chatProvider };
          const known = modelChoices({ ...this.settings, ...patch }, next.id, "chat").map(([value]) => value);
          if (this.settings.chatModel && !known.includes(this.settings.chatModel)) {
            patch.chatModel = next.chatModels[0] || "";
          }
          if (this.settings.embeddingProvider === "same") {
            const embedKnown = modelChoices({ ...this.settings, ...patch }, next.id, "embed").map(([value]) => value);
            if (this.settings.embeddingModel && !embedKnown.includes(this.settings.embeddingModel)) {
              patch.embeddingModel = next.embedModels[0] || "";
            }
          }
          this.save(patch, true);
        }),
        { description: chat.provider.base ? `Default address: ${chat.provider.base}` : "Set the server address below." },
      ),
      ui.setting(
        "API key",
        ui.textInput(this.settings.chatKey, (chatKey) => this.save({ chatKey }), { secret: true }),
        {
          description: "Hidden until you show it. Saved in this plugin's folder on this computer. It is not synced.",
        },
      ),
      ui.setting("Server address", ui.textInput(this.settings.chatBase, (chatBase) => this.save({ chatBase })), {
        description: "Leave empty to use the provider's own address.",
      }),
      ui.setting(
        "Model",
        ui.dropdown(choice(this.settings.chatModel, choices), choices, (value) => this.chooseModel("chatModel", value, choices)),
      ),
    ];
    if (choice(this.settings.chatModel, choices) === "__custom__") {
      rows.push(
        ui.setting("Custom model", ui.textInput(this.settings.chatModel, (chatModel) => this.save({ chatModel }, true))),
      );
    }
    rows.push(
      ui.setting("Models from the server", ui.button("Load models", () => this.loadModels("chat"), { icon: "refresh-cw" })),
      ui.setting(
        "Temperature",
        ui.numberInput(Number(this.settings.temperature) || 0, (temperature) => this.save({ temperature }), {
          min: 0,
          max: 2,
          step: 0.1,
        }),
      ),
      ui.setting(
        "Reply length",
        ui.numberInput(Number(this.settings.maxTokens) || 4096, (maxTokens) => this.save({ maxTokens }), {
          min: 256,
          max: 32000,
          step: 256,
        }),
        { description: "The most tokens the model may write in one reply." },
      ),
      ui.heading("Embeddings"),
      ui.setting(
        "Embedding provider",
        ui.dropdown(this.settings.embeddingProvider, embeddingProviderChoices(), (embeddingProvider) => {
          const patch = { embeddingProvider };
          if (embeddingProvider !== "same" && embeddingProvider !== "none") {
            const next = PROVIDERS[embeddingProvider];
            const known = modelChoices({ ...this.settings, embeddingProvider }, next.id, "embed").map(([value]) => value);
            if (next && !known.includes(this.settings.embeddingModel)) patch.embeddingModel = next.embedModels[0] || "";
          }
          this.save(patch);
        }),
        {
          description: embed
            ? `Indexing with ${embed.model}.`
            : "Anthropic has no embedding model. Pick another provider, or None to search by keywords only.",
        },
      ),
    );
    if (this.settings.embeddingProvider !== "same" && this.settings.embeddingProvider !== "none") {
      rows.push(
        ui.setting(
          "Embedding API key",
          ui.textInput(this.settings.embeddingKey, (embeddingKey) => this.save({ embeddingKey }), { secret: true }),
          { description: "Hidden until you show it. Leave empty to use the chat key." },
        ),
        ui.setting(
          "Embedding server",
          ui.textInput(this.settings.embeddingBase, (embeddingBase) => this.save({ embeddingBase })),
          { description: "Leave empty to use that provider's own address." },
        ),
      );
    }
    if (embedChoices.length) {
      rows.push(
        ui.setting(
          "Embedding model",
          ui.dropdown(choice(this.settings.embeddingModel, embedChoices), embedChoices, (value) =>
            this.chooseModel("embeddingModel", value, embedChoices),
          ),
        ),
      );
      if (choice(this.settings.embeddingModel, embedChoices) === "__custom__") {
        rows.push(
          ui.setting(
            "Custom embedding model",
            ui.textInput(this.settings.embeddingModel, (embeddingModel) => this.save({ embeddingModel })),
          ),
        );
      }
      rows.push(
        ui.setting(
          "Embedding models",
          ui.button("Load models", () => this.loadModels("embed"), { icon: "refresh-cw" }),
        ),
      );
    }
    rows.push(
      ui.text(indexSummary((name) => this.readFile(name))),
      this.activity ? ui.text(this.activity, { small: true, muted: true }) : null,
      ui.setting(
        "Vault index",
        this.indexing
          ? ui.button("Stop", () => this.stopIndex(), { icon: "circle-stop" })
          : ui.button("Index the vault", () => this.startIndex(), { icon: "refresh-cw" }),
        { description: "Embeds notes so search can find a passage that does not share the question's words." },
      ),
      ui.setting(
        "Refresh the index",
        ui.toggle(this.settings.indexRefresh === "change", (on) =>
          this.save({ indexRefresh: on ? "change" : "off" }),
        ),
        { description: "Embeds changed notes about two seconds after a note is saved, renamed, or deleted." },
      ),
      ui.setting("Remove index", ui.button("Remove", () => this.removeIndex())),
      ui.heading("Agent"),
      ui.setting(
        "Include the open note",
        ui.toggle(this.settings.includeNote !== false, (includeNote) => this.save({ includeNote })),
        { description: "Send the note that is open, and the selection, with the question." },
      ),
      ui.setting(
        "Search the vault",
        ui.toggle(this.settings.searchVault !== false, (searchVault) => this.save({ searchVault })),
        { description: "Attach a few matching passages before the model answers." },
      ),
      ui.setting(
        "Allow edits",
        ui.toggle(this.settings.allowEdits !== false, (allowEdits) => this.save({ allowEdits })),
        { description: "The agent may create notes and change existing ones. It cannot delete notes." },
      ),
      ui.heading("Writing"),
      ui.setting(
        "Inline assistance",
        ui.toggle(this.settings.inlineAssist !== false, (inlineAssist) => this.save({ inlineAssist })),
        {
          description:
            "After you pause, a short continuation is prepared. Alt+\\ inserts it. The note stays as it is until then. Alt+Shift+\\ dismisses it.",
        },
      ),
      ui.setting(
        "Pause",
        ui.numberInput(inlineDebounceMs(this.settings), (inlineDebounce) => this.save({ inlineDebounce }), {
          min: 200,
          max: 5000,
          step: 100,
        }),
        { description: "How long the note stays still before that request, in milliseconds." },
      ),
      ui.setting(
        "Suggestion length",
        ui.numberInput(inlineMaxChars(this.settings), (inlineMaxChars) => this.save({ inlineMaxChars }), {
          min: 40,
          max: 2000,
          step: 20,
        }),
        { description: "The most characters a continuation may add." },
      ),
      ui.heading("Instructions"),
      ui.textArea(this.settings.system, (system) => this.save({ system }), { id: "system", rows: 8 }),
    );
    return rows;
  }

  chooseModel(key, value, choices) {
    if (value === "__custom__") {
      if (choices.some(([item]) => item === this.settings[key])) this.save({ [key]: "" }, key === "chatModel");
      else this.tab.refresh();
      return;
    }
    this.save({ [key]: value }, key === "chatModel");
  }

  async loadModels(which) {
    this.activity = "Loading models…";
    this.tab.refresh();
    try {
      const found = await listModels(this.settings, which);
      const providerId = which === "embed"
        ? this.settings.embeddingProvider === "same"
          ? this.settings.chatProvider
          : this.settings.embeddingProvider
        : this.settings.chatProvider;
      const discovered = { ...this.settings.discovered };
      const previous = discovered[providerId] || { chat: [], embed: [] };
      discovered[providerId] = {
        chat: mergeNames(previous.chat, found.chat),
        embed: mergeNames(previous.embed, found.embed),
      };
      this.activity = `Loaded ${found.chat.length} chat and ${found.embed.length} embedding models.`;
      this.save({ discovered });
      new Notice(this.activity);
    } catch (error) {
      this.activity = error.message || String(error);
      this.tab.refresh();
      new Notice(this.activity);
    }
  }

  /** What search can do now: the index only counts when its model matches. */
  searchStatus() {
    if (this.indexing) return "Updating index…";
    const endpoint = embedEndpoint(this.settings);
    let manifest = null;
    try {
      manifest = JSON.parse(this.readFile("index/manifest.json") || "null");
    } catch {
      manifest = null;
    }
    if (!endpoint || !manifest || !(Number(manifest.parts) > 0)) return "Keyword search only";
    if (manifest.model !== endpoint.model || manifest.provider !== endpoint.id) return "Keyword search only";
    return `Semantic search · ${manifest.model}`;
  }

  async startIndex({ auto = false } = {}) {
    if (this.indexing) return;
    const token = {};
    this.indexing = token;
    this.activity = "Indexing…";
    this.tab.refresh();
    this.panel.refresh();
    try {
      await indexVault({
        app: this.app,
        settings: this.settings,
        read: (name) => this.readFile(name),
        write: (name, text) => this.writeFile(name, text),
        onStatus: (status) => {
          if (this.indexing !== token) return;
          this.activity = status;
          this.tab.refresh();
        },
        stopped: () => this.indexing !== token,
      });
      if (this.indexing === token && !auto) new Notice("The vault index is updated.");
    } catch (error) {
      if (this.indexing === token) this.activity = error.message || String(error);
    } finally {
      const finished = this.indexing === token;
      if (finished) this.indexing = null;
      this.tab.refresh();
      this.panel.refresh();
      if (this.indexPassOwed) {
        this.indexPassOwed = false;
        if (finished && this.settings.indexRefresh === "change") this.startIndex({ auto: true });
      }
    }
  }

  stopIndex() {
    this.indexing = null;
    this.indexPassOwed = false;
    this.activity = "Indexing stopped.";
    this.tab.refresh();
    this.panel.refresh();
  }

  removeIndex() {
    clearIndex((name, text) => this.writeFile(name, text));
    this.activity = "Index removed.";
    this.tab.refresh();
    this.panel.refresh();
  }

  save(patch, refreshPanel) {
    if ("inlineDebounce" in patch) patch.inlineDebounce = inlineDebounceMs({ inlineDebounce: patch.inlineDebounce });
    if ("inlineMaxChars" in patch) patch.inlineMaxChars = inlineMaxChars({ inlineMaxChars: patch.inlineMaxChars });
    if (patch.inlineAssist === false) this.dismissSuggestion();
    Object.assign(this.settings, patch);
    this.saveData(this.settings);
    if (patch.indexRefresh === "off") {
      if (this.indexTimer != null) clearTimeout(this.indexTimer);
      this.indexTimer = null;
      this.indexPassOwed = false;
    } else if (
      EMBEDDING_KEYS.some((key) => key in patch) ||
      (this.settings.embeddingProvider === "same" && ["chatProvider", "chatBase", "chatKey"].some((key) => key in patch))
    ) {
      // A different model means the stored vectors no longer match.
      this.scheduleIndex();
    }
    this.tab.refresh();
    if ("includeNote" in patch) this.syncContextChips();
    if (refreshPanel) this.panel.refresh();
  }
}

function blankSession() {
  return {
    id: `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: "New chat",
    messages: [],
    draft: "",
    context: null,
    notes: [],
    omitNote: "",
    omitSelection: "",
    open: true,
    updated: Date.now(),
  };
}

function loadSessions(text) {
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const sessions = Array.isArray(data?.sessions) ? data.sessions.map(sanitizeSession).filter(Boolean) : [];
  return { sessions, activeId: data?.activeId ? String(data.activeId) : "" };
}

function sanitizeSession(session) {
  if (!session || typeof session !== "object" || !session.id) return null;
  return {
    id: String(session.id),
    title: String(session.title || "New chat"),
    messages: Array.isArray(session.messages) ? session.messages : [],
    draft: String(session.draft || ""),
    context: session.context && session.context.text ? session.context : null,
    omitNote: session.omitNote ? String(session.omitNote) : "",
    omitSelection: session.omitSelection ? String(session.omitSelection) : "",
    notes: Array.isArray(session.notes)
      ? session.notes
          .filter((note) => note && note.path && note.text)
          .map((note) => ({
            path: String(note.path),
            label: String(note.label || note.path).split("/").pop(),
            text: String(note.text),
          }))
      : [],
    result:
      session.result && Number.isFinite(Number(session.result.ms))
        ? { ms: Number(session.result.ms), tokens: Number(session.result.tokens) || 0 }
        : null,
    open: session.open !== false,
    updated: Number(session.updated) || 0,
  };
}

function trimSessions(sessions) {
  if (sessions.length <= 40) return sessions;
  const open = sessions.filter((session) => session.open);
  const closed = sessions
    .filter((session) => !session.open)
    .sort((a, b) => b.updated - a.updated);
  const room = Math.max(0, 40 - open.length);
  const kept = new Set([...open, ...closed.slice(0, room)].map((session) => session.id));
  return sessions.filter((session) => kept.has(session.id));
}

function mentionQuery(draft) {
  const match = String(draft || "").match(/\[\[([^\]\n]*)$/);
  return match ? match[1] : null;
}

function noteScore(note, query) {
  if (!query) return note.modified || 1;
  const name = String(note.name || "").toLowerCase();
  const path = String(note.path || "").toLowerCase();
  if (name === query || path === query) return 100;
  if (name.startsWith(query)) return 80;
  const parts = query.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every((part) => name.includes(part) || path.includes(part))) return 70;
  if (name.includes(query) || path.startsWith(query)) return 60;
  if (path.includes(query)) return 40;
  return 0;
}

function clipNote(text) {
  const value = String(text || "");
  if (value.length <= 12000) return value;
  return `${value.slice(0, 12000)}\n\n[The rest of the note was left out.]`;
}

function chatTitle(text, attachment, notes) {
  const line = String(text || attachment?.label || notes?.[0]?.label || "New chat").trim().split("\n")[0];
  if (!line) return "New chat";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

function sessionStamp(updated) {
  if (!updated) return "";
  return new Date(updated).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function takeSnapshot(editor, note) {
  if (!editor || !note) return null;
  try {
    const selected = editor.somethingSelected() ? editor.getSelection() : "";
    const from = editor.getCursor("from");
    const head = editor.getCursor("head");
    const to = editor.getCursor("to");
    const at = selected ? from : head;
    const afterFrom = selected ? to : head;
    const last = editor.lastLine();
    return {
      path: note.path,
      mode: note.mode,
      line: at.line,
      ch: at.ch,
      selection: selected,
      before: editor.getRange({ line: 0, ch: 0 }, at),
      after: editor.getRange(afterFrom, { line: last, ch: editor.getLine(last).length }),
    };
  } catch {
    return null;
  }
}

function selectionChipLabel(editor, note) {
  const file = String(note.path).split("/").pop();
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  let end = to.line;
  if (to.ch === 0 && end > from.line) end -= 1;
  const start = from.line + 1;
  const last = end + 1;
  const lines = start === last ? String(start) : `${start}-${last}`;
  return `${file} (${lines})`;
}

function flatten(lists) {
  const out = [];
  for (const list of lists) {
    if (Array.isArray(list)) out.push(...list);
    else if (list != null && list !== false) out.push(list);
  }
  return out;
}

function choice(model, options) {
  return options.some(([value]) => value === model) ? model : "__custom__";
}

function mergeNames(previous, next) {
  const seen = new Set();
  const names = [];
  for (const name of [...(next || []), ...(previous || [])]) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function worked(message) {
  const seconds = Math.max(1, Math.round((message.ms || 0) / 1000));
  const count = message.actions?.length || 0;
  const time = `Worked for ${seconds}s`;
  if (!count) return time;
  return `${time} · ${count} ${count === 1 ? "action" : "actions"}`;
}
