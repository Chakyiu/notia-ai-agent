// Keyword search over the vault, and an embedding index stored beside the
// plugin. Vectors are quantized so a few hundred passages fit in the files
// a plugin is allowed to write.

import { embed } from "./provider.js";
import { embedEndpoint } from "./settings.js";

const PART_LIMIT = 700000;
const MAX_CHUNKS = 500;
const BATCH = 16;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function keywordSearch(app, query, limit = 6) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
  if (!terms.length) return [];
  const ranked = app.vault
    .getNotes()
    .map((note) => {
      const name = `${note.path} ${note.tags.join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (name.includes(term)) score += 5;
      return { note, score };
    })
    .sort((a, b) => b.score - a.score);
  const preferred = ranked.filter((item) => item.score > 0);
  const rest = ranked.filter((item) => item.score === 0);
  const consider = preferred.concat(rest).slice(0, 60);
  const deadline = Date.now() + 250;
  const hits = [];
  for (const item of consider) {
    if (Date.now() > deadline && hits.length >= limit) break;
    let text = "";
    try {
      text = app.vault.read(item.note.path);
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    let score = item.score;
    let at = -1;
    for (const term of terms) {
      const found = lower.indexOf(term);
      if (found >= 0) {
        score += 2;
        if (at < 0) at = found;
      }
    }
    if (!score) continue;
    const start = Math.max(0, (at < 0 ? 0 : at) - 80);
    hits.push({ path: item.note.path, score, text: text.slice(start, start + 400).trim() });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Keyword hits, with embedding hits first when an index exists for this model. */
export async function searchNotes(app, settings, query, read, limit = 6) {
  const keyword = keywordSearch(app, query, limit);
  let semantic = [];
  try {
    semantic = await semanticSearch(settings, query, read, limit);
  } catch {
    semantic = [];
  }
  const seen = new Set();
  const hits = [];
  for (const hit of [...semantic, ...keyword]) {
    const key = `${hit.path}\n${hit.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
}

async function semanticSearch(settings, query, read, limit) {
  const endpoint = embedEndpoint(settings);
  const index = loadIndex(read);
  if (!endpoint || !index || index.model !== endpoint.model || index.provider !== endpoint.id) return [];
  if (!index.chunks.length) return [];
  const [vector] = await embed(settings, [String(query || "")]);
  if (!vector?.length) return [];
  return index.chunks
    .map((chunk) => ({
      path: chunk.path,
      text: chunk.text,
      score: cosine(vector, unpackVector(chunk)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function indexVault({ app, settings, read, write, onStatus, stopped }) {
  const endpoint = embedEndpoint(settings);
  if (!endpoint) throw new Error("Choose an embedding provider and model first.");
  if (endpoint.provider.needsKey && !endpoint.key) {
    throw new Error(`Add an API key for ${endpoint.provider.label}.`);
  }
  const previous = loadIndex(read);
  const reusable =
    previous && previous.model === endpoint.model && previous.provider === endpoint.id ? previous.chunks : [];
  const byNote = new Map();
  for (const chunk of reusable) {
    const list = byNote.get(chunk.path) || [];
    list.push(chunk);
    byNote.set(chunk.path, list);
  }
  const notes = app.vault.getNotes().slice().sort((a, b) => (b.modified || 0) - (a.modified || 0));
  const kept = [];
  const pending = [];
  for (const note of notes) {
    const existing = byNote.get(note.path);
    if (existing?.length && existing[0].modified === note.modified) {
      kept.push(...existing);
      continue;
    }
    pending.push(note);
  }
  const fresh = [];
  for (let index = 0; index < pending.length; index += BATCH) {
    if (stopped()) return;
    const batch = pending.slice(index, index + BATCH);
    const pieces = [];
    for (const note of batch) {
      let text = "";
      try {
        text = app.vault.read(note.path);
      } catch {
        continue;
      }
      for (const piece of chunkText(text)) {
        pieces.push({ path: note.path, modified: note.modified, text: piece });
      }
    }
    onStatus(`Indexing ${Math.min(index + batch.length, pending.length)} of ${pending.length} changed notes…`);
    if (!pieces.length) continue;
    const vectors = await embed(settings, pieces.map((piece) => piece.text));
    pieces.forEach((piece, pieceIndex) => {
      const packed = packVector(vectors[pieceIndex] || []);
      fresh.push({ ...piece, scale: packed.scale, data: packed.data });
    });
  }
  if (stopped()) return;
  const chunks = kept.concat(fresh).slice(0, MAX_CHUNKS);
  saveIndex(write, { provider: endpoint.id, model: endpoint.model, chunks });
  onStatus(`Indexed ${chunks.length} passages from ${notes.length} notes with ${endpoint.model}.`);
}

export function clearIndex(write) {
  saveIndex(write, { provider: "", model: "", chunks: [] });
}

export function indexSummary(read) {
  const index = loadIndex(read);
  if (!index?.chunks.length) return "No index yet. Keyword search still works.";
  const notes = new Set(index.chunks.map((chunk) => chunk.path));
  return `${index.chunks.length} passages from ${notes.size} notes, embedded with ${index.model}.`;
}

function chunkText(text) {
  const blocks = String(text || "").split(/\n{2,}/);
  const chunks = [];
  let current = "";
  for (const block of blocks) {
    const piece = block.trim();
    if (!piece) continue;
    const next = current ? `${current}\n\n${piece}` : piece;
    if (next.length > 1200 && current) {
      chunks.push(current);
      current = piece;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((chunk) => chunk.length > 0).slice(0, 40);
}

function loadIndex(read) {
  const raw = read("index/manifest.json");
  if (!raw) return null;
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return null;
  }
  const chunks = [];
  const parts = Number(manifest.parts) || 0;
  for (let index = 0; index < parts; index += 1) {
    const part = read(`index/part-${index}.json`);
    if (!part) continue;
    try {
      const parsed = JSON.parse(part);
      if (Array.isArray(parsed.chunks)) chunks.push(...parsed.chunks);
    } catch {
      // A torn part is skipped; the next index rebuilds it.
    }
  }
  return { provider: manifest.provider || "", model: manifest.model || "", chunks };
}

function saveIndex(write, index) {
  const parts = [];
  let current = [];
  for (const chunk of index.chunks) {
    current.push(chunk);
    if (JSON.stringify(current).length > PART_LIMIT) {
      const last = current.pop();
      parts.push(current);
      current = last ? [last] : [];
    }
  }
  if (current.length) parts.push(current);
  parts.forEach((chunks, index) => {
    write(`index/part-${index}.json`, JSON.stringify({ chunks }));
  });
  write(
    "index/manifest.json",
    JSON.stringify({ provider: index.provider, model: index.model, parts: parts.length }),
  );
}

function packVector(vector) {
  let max = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = Math.abs(vector[index]);
    if (value > max) max = value;
  }
  const scale = max || 1;
  const bytes = new Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    let quantized = Math.round((vector[index] / scale) * 127);
    if (quantized > 127) quantized = 127;
    if (quantized < -127) quantized = -127;
    bytes[index] = quantized + 128;
  }
  return { scale, data: encodeBytes(bytes) };
}

function unpackVector(packed) {
  const bytes = decodeBytes(packed.data || "");
  const vector = new Array(bytes.length);
  const scale = Number(packed.scale) || 1;
  for (let index = 0; index < bytes.length; index += 1) {
    vector[index] = ((bytes[index] - 128) / 127) * scale;
  }
  return vector;
}

function cosine(left, right) {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function encodeBytes(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += ALPHABET[(triple >> 18) & 63];
    out += ALPHABET[(triple >> 12) & 63];
    out += index + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63] : "=";
    out += index + 2 < bytes.length ? ALPHABET[triple & 63] : "=";
  }
  return out;
}

function decodeBytes(data) {
  const clean = String(data).replace(/=+$/, "");
  const bytes = [];
  for (let index = 0; index < clean.length; index += 4) {
    const a = ALPHABET.indexOf(clean[index]);
    const b = ALPHABET.indexOf(clean[index + 1]);
    const c = ALPHABET.indexOf(clean[index + 2]);
    const d = ALPHABET.indexOf(clean[index + 3]);
    const triple = ((a < 0 ? 0 : a) << 18) | ((b < 0 ? 0 : b) << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    bytes.push((triple >> 16) & 255);
    if (index + 2 < clean.length) bytes.push((triple >> 8) & 255);
    if (index + 3 < clean.length) bytes.push(triple & 255);
  }
  return bytes;
}
