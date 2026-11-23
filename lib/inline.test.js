import assert from "node:assert/strict";
import { test } from "node:test";

import {
  anchorKey,
  continuationPrompt,
  normalizeSuggestion,
  positionAfter,
  statusPreview,
  suggestionMatches,
  writeContinuation,
} from "./inline.js";
import { defaults, inlineDebounceMs, inlineMaxChars } from "./settings.js";

test("a saved settings file keeps its choices when new keys are filled in", () => {
  const saved = { chatModel: "local-model", includeNote: false, chatKey: "secret" };
  const settings = { ...defaults(), ...saved };
  assert.equal(settings.chatModel, "local-model");
  assert.equal(settings.includeNote, false);
  assert.equal(settings.chatKey, "secret");
  assert.equal(settings.inlineAssist, true);
  assert.equal(settings.inlineDebounce, 800);
  assert.equal(settings.inlineMaxChars, 400);
});

test("inline numbers clamp into the range the setting allows", () => {
  assert.equal(inlineDebounceMs({}), 800);
  assert.equal(inlineDebounceMs({ inlineDebounce: 10 }), 200);
  assert.equal(inlineDebounceMs({ inlineDebounce: 9000 }), 5000);
  assert.equal(inlineMaxChars({ inlineMaxChars: 1 }), 40);
  assert.equal(inlineMaxChars({ inlineMaxChars: 99999 }), 2000);
});

test("normalizeSuggestion drops a fence and a repeated last line", () => {
  const before = "The harbor stays quiet at dusk";
  const text = normalizeSuggestion("```md\nThe harbor stays quiet at dusk and the lights come on.\n```", 400, before);
  assert.equal(text, " and the lights come on.");
});

test("normalizeSuggestion stops on a word inside the length limit", () => {
  const word = "abcdefghij";
  const text = normalizeSuggestion(`${word}${word}${word} ${word}${word}${word}`, 40, "");
  assert.equal(text, `${word}${word}${word}`);
});

test("positionAfter counts lines the way the editor does", () => {
  assert.deepEqual(positionAfter({ line: 2, ch: 4 }, "ab"), { line: 2, ch: 6 });
  assert.deepEqual(positionAfter({ line: 2, ch: 4 }, "ab\ncd"), { line: 3, ch: 2 });
});

test("suggestionMatches rejects a caret that moved", () => {
  const pending = {
    path: "a.md",
    line: 1,
    ch: 3,
    selection: "",
    beforeTail: "abc",
    text: " more",
  };
  const same = { path: "a.md", line: 1, ch: 3, selection: "", before: "abc" };
  assert.equal(suggestionMatches(pending, same), true);
  assert.equal(suggestionMatches(pending, { ...same, ch: 4 }), false);
  assert.equal(anchorKey(same) === anchorKey({ ...same, ch: 4 }), false);
});

test("the prompt asks to replace a selection and to insert when there is none", () => {
  assert.match(continuationPrompt({ before: "Hi", after: "", selection: "Hi", maxChars: 100 }), /replace it/);
  assert.match(continuationPrompt({ before: "Hi", after: "", selection: "", maxChars: 100 }), /insert at the cursor/);
});

test("writeContinuation returns only the insertion and drops a stopped one", async () => {
  let cap = 0;
  const complete = async (_settings, _system, _messages, tools, _onDelta, limits) => {
    cap = limits.maxTokens;
    assert.equal(tools.length, 0);
    return { text: "```\nnext sentence\n```" };
  };
  const text = await writeContinuation({
    complete,
    settings: {},
    before: "Hello",
    after: "",
    selection: "",
    maxChars: 120,
    signal: { stopped: false },
  });
  assert.equal(text, "next sentence");
  assert.equal(cap, Math.max(32, Math.ceil(120 / 3)));
  const dropped = await writeContinuation({
    complete,
    settings: {},
    before: "Hello",
    after: "",
    selection: "",
    maxChars: 120,
    signal: { stopped: true },
  });
  assert.equal(dropped, "");
});

test("statusPreview stays on one short line", () => {
  assert.equal(statusPreview("one\ntwo"), "one two");
  assert.equal(statusPreview("x".repeat(60)).length, 48);
});
