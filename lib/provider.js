// One chat turn, one embedding batch, and the model list, for each provider.
// The shapes below are the providers' own HTTP APIs.

import api from "notia";

import { chatEndpoint, embedConnection, embedEndpoint, joinUrl } from "./settings.js";

const requestUrl = api.requestUrl;

export async function request(options) {
  if (typeof requestUrl !== "function") {
    throw new Error("This Notia is too old for the agent. Update Notia and try again.");
  }
  const response = await requestUrl({ timeout: 120000, ...options });
  const text = response.text || "";
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(failure(response.status, json, text));
  }
  return { status: response.status, text, json, headers: response.headers || {} };
}

function failure(status, json, text) {
  const error = json && json.error;
  const message =
    (typeof error === "string" && error) ||
    (error && typeof error.message === "string" && error.message) ||
    (json && typeof json.message === "string" && json.message) ||
    "";
  if (message) return clip(message);
  const body = text.trim();
  if (body && body.length < 400 && !body.startsWith("<")) return body;
  return `The server returned HTTP ${status}.`;
}

function clip(text) {
  const value = String(text).trim();
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

function parseArgs(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function bearer(key) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Sends one turn. `messages` use roles system is separate: user, assistant,
 * and tool. An assistant message may carry `toolCalls`. A tool message
 * carries `toolCallId`, `name`, and `content`.
 */
export async function complete(settings, system, messages, tools) {
  const chat = chatEndpoint(settings);
  const temperature = Number(settings.temperature);
  const maxTokens = Math.max(1, Math.round(Number(settings.maxTokens) || 4096));
  if (chat.provider.style === "anthropic") {
    return completeAnthropic(chat, system, messages, tools, temperature, maxTokens);
  }
  if (chat.provider.style === "gemini") {
    return completeGemini(chat, system, messages, tools, temperature, maxTokens);
  }
  return completeOpenAI(chat, system, messages, tools, temperature, maxTokens);
}

async function completeOpenAI(chat, system, messages, tools, temperature, maxTokens) {
  const body = {
    model: chat.model,
    messages: toOpenAI(system, messages),
  };
  if (chat.provider.id === "ollama" || chat.provider.id === "compatible") {
    body.max_tokens = maxTokens;
  } else {
    body.max_completion_tokens = maxTokens;
  }
  // Reasoning models reject a temperature.
  if (!/^o\d/i.test(chat.model)) body.temperature = temperature;
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  let response;
  try {
    response = await request({
      url: joinUrl(chat.base, "chat/completions"),
      method: "POST",
      headers: bearer(chat.key),
      body: JSON.stringify(body),
    });
  } catch (error) {
    // A server that does not understand tools gets one try without them.
    if (!tools.length || !/tool/i.test(error.message)) throw error;
    delete body.tools;
    response = await request({
      url: joinUrl(chat.base, "chat/completions"),
      method: "POST",
      headers: bearer(chat.key),
      body: JSON.stringify(body),
    });
  }
  const message = response.json?.choices?.[0]?.message;
  if (!message) throw new Error("The model returned no message.");
  const toolCalls = (message.tool_calls || [])
    .map((call, index) => ({
      id: String(call.id || `call_${index}`),
      name: call.function?.name || call.name,
      arguments: parseArgs(call.function?.arguments ?? call.arguments),
    }))
    .filter((call) => call.name);
  return { text: typeof message.content === "string" ? message.content : "", toolCalls };
}

function toOpenAI(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    } else if (message.role === "assistant" && message.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
        })),
      });
    } else {
      out.push({ role: message.role, content: message.content || "" });
    }
  }
  return out;
}

async function completeAnthropic(chat, system, messages, tools, temperature, maxTokens) {
  const body = {
    model: chat.model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: toAnthropic(messages),
  };
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  const response = await request({
    url: joinUrl(chat.base, "messages"),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": chat.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const blocks = response.json?.content;
  if (!Array.isArray(blocks)) throw new Error("The model returned no message.");
  const text = blocks
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n\n");
  const toolCalls = blocks
    .filter((block) => block.type === "tool_use" && block.name)
    .map((block, index) => ({
      id: String(block.id || `tool_${index}`),
      name: block.name,
      arguments: parseArgs(block.input),
    }));
  return { text, toolCalls };
}

function toAnthropic(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls || []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments || {} });
      }
      if (content.length) out.push({ role: "assistant", content });
    } else if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content || "" };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else {
      out.push({ role: "user", content: message.content || "" });
    }
  }
  return out;
}

async function completeGemini(chat, system, messages, tools, temperature, maxTokens) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGemini(messages),
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }
  const url = `${chat.base}/models/${encodeURIComponent(chat.model)}:generateContent?key=${encodeURIComponent(chat.key)}`;
  const response = await request({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parts = response.json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    const reason = response.json?.promptFeedback?.blockReason;
    throw new Error(reason ? `The model declined the request (${reason}).` : "The model returned no message.");
  }
  const text = parts
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n\n");
  const toolCalls = parts
    .filter((part) => part.functionCall?.name)
    .map((part, index) => ({
      id: `gemini_${index}_${part.functionCall.name}`,
      name: part.functionCall.name,
      arguments: parseArgs(part.functionCall.args),
    }));
  return { text, toolCalls };
}

function toGemini(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls || []) {
        parts.push({ functionCall: { name: call.name, args: call.arguments || {} } });
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: message.name, response: { result: message.content || "" } } }],
      });
    } else {
      contents.push({ role: "user", parts: [{ text: message.content || "" }] });
    }
  }
  return contents;
}

/** Embeds each string and returns one vector per string, in the same order. */
export async function embed(settings, texts) {
  const endpoint = embedEndpoint(settings);
  if (!endpoint) throw new Error("Choose an embedding model.");
  if (endpoint.provider.needsKey && !endpoint.key) {
    throw new Error(`Add an API key for ${endpoint.provider.label}.`);
  }
  if (endpoint.provider.style === "gemini") return embedGemini(endpoint, texts);
  const response = await request({
    url: joinUrl(endpoint.base, "embeddings"),
    method: "POST",
    headers: bearer(endpoint.key),
    body: JSON.stringify({ model: endpoint.model, input: texts }),
  });
  const data = response.json?.data;
  if (!Array.isArray(data)) throw new Error("The embedding model returned nothing.");
  return data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => item.embedding || []);
}

async function embedGemini(endpoint, texts) {
  const requests = texts.map((text) => ({
    model: `models/${endpoint.model}`,
    content: { parts: [{ text }] },
  }));
  const url = `${endpoint.base}/models/${encodeURIComponent(endpoint.model)}:batchEmbedContents?key=${encodeURIComponent(endpoint.key)}`;
  const response = await request({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  const embeddings = response.json?.embeddings;
  if (!Array.isArray(embeddings)) throw new Error("The embedding model returned nothing.");
  return embeddings.map((item) => item.values || []);
}

/**
 * Asks the provider which models it has. Returns `{ chat, embed }`, names
 * only. A provider that cannot list models throws.
 */
export async function listModels(settings, which) {
  const endpoint = which === "embed" ? embedConnection(settings) : chatEndpoint(settings);
  const provider = endpoint?.provider;
  if (!provider) throw new Error("Choose a provider that has an embedding model.");
  if (!endpoint.base) throw new Error(`Set the server address for ${provider.label}.`);
  if (provider.needsKey && !endpoint.key) throw new Error(`Add an API key for ${provider.label}.`);
  if (provider.style === "gemini") return listGemini(endpoint);
  if (provider.style === "anthropic") return listAnthropic(endpoint);
  return listOpenAI(endpoint);
}

async function listOpenAI(endpoint) {
  const response = await request({
    url: joinUrl(endpoint.base, "models"),
    method: "GET",
    headers: bearer(endpoint.key),
  });
  return splitNames((response.json?.data || []).map((item) => item.id).filter(Boolean));
}

async function listAnthropic(endpoint) {
  const response = await request({
    url: joinUrl(endpoint.base, "models"),
    method: "GET",
    headers: {
      "x-api-key": endpoint.key,
      "anthropic-version": "2023-06-01",
    },
  });
  const names = (response.json?.data || []).map((item) => item.id || item.name).filter(Boolean);
  return splitNames(names);
}

async function listGemini(endpoint) {
  const response = await request({
    url: `${endpoint.base}/models?key=${encodeURIComponent(endpoint.key)}`,
    method: "GET",
  });
  const chat = [];
  const embed = [];
  for (const model of response.json?.models || []) {
    const name = String(model.name || "").replace(/^models\//, "");
    if (!name) continue;
    const methods = model.supportedGenerationMethods || [];
    if (methods.includes("embedContent")) embed.push(name);
    if (methods.includes("generateContent")) chat.push(name);
  }
  return { chat, embed };
}

function splitNames(names) {
  const chat = [];
  const embed = [];
  for (const name of names) {
    if (/embed/i.test(name)) embed.push(name);
    else chat.push(name);
  }
  return { chat, embed };
}
