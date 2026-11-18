import api from "notia";

import { answer } from "./lib/agent.js";
import { listModels } from "./lib/provider.js";
import { clearIndex, indexSummary, indexVault } from "./lib/search.js";
import {
  PROVIDERS,
  chatEndpoint,
  chatError,
  defaults,
  embedEndpoint,
  embeddingProviderChoices,
  modelChoices,
  providerChoices,
} from "./lib/settings.js";

const { Plugin, Notice, ui } = api;

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
    this.activity = "";

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
    setInterval(() => {
      if (this.workingId) this.panel.refresh();
    }, 1000);
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
      id: "index",
      name: "Index notes for the agent",
      icon: "refresh-cw",
      callback: () => this.startIndex(),
    });

    if (typeof api.requestUrl !== "function") {
      new Notice("This Notia is too old for the agent. Update Notia and try again.");
    }
  }

  renderChat() {
    const session = this.chat();
    const body = this.historyOpen ? this.renderHistory() : this.renderMessages(session);
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
      .sort((a, b) => a.updated - b.updated);
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
      ui.text(live ? "Working" : "Done", { small: true }),
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
      ui.composer([
        session.context
          ? ui.chip(session.context.label, () => {
              session.context = null;
              this.panel.refresh();
            })
          : null,
        ui.textArea(session.draft, (draft) => {
          session.draft = draft;
        }, {
          id: "composer",
          rows: 1,
          maxRows: 7,
          plain: true,
          placeholder: "Ask anything",
          onSubmit: (text) => this.submit(text),
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
                ui.button("", () => this.submit(session.draft), {
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
      if (message.text) blocks.push(ui.markdown(quote(message.text)));
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
    if (current && !current.messages.length && !current.draft && !current.context) {
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
    const empty = !session.messages.length && !session.draft && !session.context;
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

  stop() {
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
    if (!question && !attachment) return;
    if (this.workingId) {
      if (this.workingId !== session.id) new Notice("The other chat is still replying.");
      return;
    }
    const problem = chatError(this.settings);
    if (!session.messages.some((message) => message.role === "user")) {
      session.title = chatTitle(question, attachment);
    }
    session.draft = "";
    session.context = null;
    session.updated = Date.now();
    session.messages.push({ role: "user", text: question, attachment });
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
      ui.text("The agent sits in the right sidebar. A sparkles button above the note opens it."),
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

  async startIndex() {
    if (this.indexing) return;
    const token = {};
    this.indexing = token;
    this.activity = "Indexing…";
    this.tab.refresh();
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
      if (this.indexing === token) new Notice("The vault index is updated.");
    } catch (error) {
      if (this.indexing === token) this.activity = error.message || String(error);
    } finally {
      if (this.indexing === token) this.indexing = null;
      this.tab.refresh();
    }
  }

  stopIndex() {
    this.indexing = null;
    this.activity = "Indexing stopped.";
    this.tab.refresh();
  }

  removeIndex() {
    clearIndex((name, text) => this.writeFile(name, text));
    this.activity = "Index removed.";
    this.tab.refresh();
  }

  save(patch, refreshPanel) {
    Object.assign(this.settings, patch);
    this.saveData(this.settings);
    this.tab.refresh();
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

function chatTitle(text, attachment) {
  const line = String(text || attachment?.label || "New chat").trim().split("\n")[0];
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

function quote(text) {
  return String(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function worked(message) {
  const seconds = Math.max(1, Math.round((message.ms || 0) / 1000));
  const count = message.actions?.length || 0;
  const time = `Worked for ${seconds}s`;
  if (!count) return time;
  return `${time} · ${count} ${count === 1 ? "action" : "actions"}`;
}
