// Providers, saved settings, and the address a request is sent to.
// An empty base address means the provider's own default.

export const PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    style: "openai",
    needsKey: true,
    embed: true,
    chatModels: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o", "o4-mini"],
    embedModels: ["text-embedding-3-small", "text-embedding-3-large"],
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    style: "openai",
    needsKey: true,
    embed: true,
    chatModels: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash"],
    embedModels: ["openai/text-embedding-3-small"],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    base: "https://api.anthropic.com/v1",
    style: "anthropic",
    needsKey: true,
    embed: false,
    chatModels: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"],
    embedModels: [],
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    style: "gemini",
    needsKey: true,
    embed: true,
    chatModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
    embedModels: ["gemini-embedding-001", "text-embedding-004"],
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    base: "http://127.0.0.1:11434/v1",
    style: "openai",
    needsKey: false,
    embed: true,
    chatModels: ["llama3.2", "qwen2.5", "mistral"],
    embedModels: ["nomic-embed-text", "mxbai-embed-large"],
  },
  compatible: {
    id: "compatible",
    label: "OpenAI-compatible",
    base: "",
    style: "openai",
    needsKey: false,
    embed: true,
    chatModels: [],
    embedModels: [],
  },
};

export const DEFAULT_SYSTEM = [
  "You are the agent in Notia. Notes are Markdown files in a folder, the vault.",
  "Answer from notes you can read, and say when you are not sure.",
  "Use tools to look a note up instead of inventing what it says.",
  "When you change a note, change only what was asked. Mention notes by their path.",
].join(" ");

export function defaults() {
  return {
    chatProvider: "openai",
    chatKey: "",
    chatBase: "",
    chatModel: "gpt-4.1-mini",
    embeddingProvider: "same",
    embeddingKey: "",
    embeddingBase: "",
    embeddingModel: "text-embedding-3-small",
    temperature: 0.2,
    maxTokens: 4096,
    includeNote: true,
    searchVault: true,
    allowEdits: true,
    inlineAssist: true,
    inlineDebounce: 800,
    inlineMaxChars: 400,
    indexRefresh: "off",
    system: DEFAULT_SYSTEM,
    discovered: {},
  };
}

export function providerChoices() {
  return Object.values(PROVIDERS).map((provider) => [provider.id, provider.label]);
}

export function embeddingProviderChoices() {
  return [["same", "Same as chat"], ["none", "None"], ...providerChoices()];
}

/** Listed models for a provider, plus any the server reported, plus Custom. */
export function modelChoices(settings, providerId, kind) {
  const provider = PROVIDERS[providerId];
  const builtin = provider ? (kind === "embed" ? provider.embedModels : provider.chatModels) : [];
  const found = settings.discovered?.[providerId]?.[kind] ?? [];
  const seen = new Set();
  const options = [];
  for (const model of [...builtin, ...found]) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    options.push([model, model]);
  }
  options.push(["__custom__", "Custom…"]);
  return options;
}

export function chatEndpoint(settings) {
  const provider = PROVIDERS[settings.chatProvider] ?? PROVIDERS.openai;
  const base = String(settings.chatBase || provider.base || "").replace(/\/$/, "");
  const model = String(settings.chatModel || "").trim();
  return {
    provider,
    base,
    model: model === "__custom__" ? "" : model,
    key: String(settings.chatKey || "").trim(),
  };
}

/**
 * Where embeddings are requested, or null when embeddings are off or the
 * provider has no embedding API. "Same as chat" follows the chat provider.
 */
export function embedEndpoint(settings) {
  if (settings.embeddingProvider === "none") return null;
  const id = settings.embeddingProvider === "same" ? settings.chatProvider : settings.embeddingProvider;
  const provider = PROVIDERS[id];
  if (!provider?.embed) return null;
  const baseSource = settings.embeddingProvider === "same" ? settings.chatBase : settings.embeddingBase;
  const base = String(baseSource || provider.base || "").replace(/\/$/, "");
  const keySource =
    settings.embeddingProvider === "same" || !String(settings.embeddingKey || "").trim()
      ? settings.chatKey
      : settings.embeddingKey;
  const model = String(settings.embeddingModel || provider.embedModels[0] || "").trim();
  if (!base) return null;
  if (!model || model === "__custom__") return null;
  return { provider, id, base, model, key: String(keySource || "").trim() };
}

/** The embedding server, even when a model has not been chosen yet. */
export function embedConnection(settings) {
  if (settings.embeddingProvider === "none") return null;
  const id = settings.embeddingProvider === "same" ? settings.chatProvider : settings.embeddingProvider;
  const provider = PROVIDERS[id];
  if (!provider?.embed) return null;
  const baseSource = settings.embeddingProvider === "same" ? settings.chatBase : settings.embeddingBase;
  const base = String(baseSource || provider.base || "").replace(/\/$/, "");
  const keySource =
    settings.embeddingProvider === "same" || !String(settings.embeddingKey || "").trim()
      ? settings.chatKey
      : settings.embeddingKey;
  if (!base) return null;
  return { provider, id, base, key: String(keySource || "").trim(), model: "" };
}

/** Milliseconds to wait after a keystroke before preparing a continuation. */
export function inlineDebounceMs(settings) {
  const n = Number(settings?.inlineDebounce);
  if (!Number.isFinite(n)) return 800;
  return Math.min(5000, Math.max(200, Math.round(n)));
}

/** Most characters a continuation may insert. */
export function inlineMaxChars(settings) {
  const n = Number(settings?.inlineMaxChars);
  if (!Number.isFinite(n)) return 400;
  return Math.min(2000, Math.max(40, Math.round(n)));
}

/** A sentence explaining why a chat cannot be sent, or null when it can. */
export function chatError(settings) {
  const chat = chatEndpoint(settings);
  if (!chat.base) return `Set the server address for ${chat.provider.label}.`;
  if (chat.provider.needsKey && !chat.key) return `Add an API key for ${chat.provider.label}.`;
  if (!chat.model) return "Choose a chat model.";
  return null;
}

export function joinUrl(base, path) {
  return `${String(base).replace(/\/$/, "")}/${String(path).replace(/^\//, "")}`;
}
