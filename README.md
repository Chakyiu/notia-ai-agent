# AI agent

A chat agent for [Notia](https://github.com/Chakyiu/notia), in the sidebar beside the note you have open. Ask it about the vault, and it can read notes, search them, create a note, and edit one. It does not run commands or delete notes. It can also continue the sentence you are writing.

The sparkles button above a note opens the panel. `⌘⇧A` does the same (Ctrl+Shift+A on Windows and Linux). **Ask the agent about the selection** adds the selected lines to the chat, shown as the file and the line numbers.

## Writing in the note

Notia cannot draw gray ghost text ahead of the cursor. A continuation is inserted only when you accept it, as one undo step.

| Action | Shortcut |
| --- | --- |
| Continue writing | Alt+\ (Option+\ on macOS) |
| Dismiss the suggestion | Alt+Shift+\ |

**Inline assistance** is on until you turn it off. After you pause, the status bar shows a preview (`Alt+\` and the first words). Alt+\ inserts that preview. Typing further, or moving the cursor, drops it. With the setting off, pausing does not call the model; Alt+\ still writes a continuation when you ask.

If text is selected, Alt+\ replaces the selection.

Change either shortcut under **Settings → Command palette**. Tab is not the default: Notia has no way to bind a key only while a suggestion is waiting, so Tab would fight indenting.

## Install

Link this folder into a vault and turn the plugin on in **Settings → Plugins**:

```
ln -s /path/to/notia-ai-agent /path/to/vault/.notia/plugins/ai-agent
```

Keep `notia.d.ts` beside `main.js` for editor completions. Notia also writes a copy to `.notia/plugins/notia.d.ts`.

## Settings

**Settings → AI agent** chooses:

| Setting | What it does |
| --- | --- |
| Provider | OpenAI, OpenRouter, Anthropic, Google Gemini, Ollama, or any OpenAI-compatible server |
| API key | Stored in this plugin's `data.json` on this computer. Community plugins are not synced |
| Server address | Empty uses the provider's own address. Ollama's default is `http://127.0.0.1:11434/v1` |
| Model | A listed model, a custom name, or **Load models** to ask the server |
| Embedding provider | Same as chat, a different provider, or None |
| Embedding model | Used when you index the vault |
| Refresh the index | Off, or keep the index current about two seconds after a note is saved, renamed, or deleted |
| Include the open note | Sends the open note and the selection with the question. On by default |
| Search the vault | Attaches a few matching passages |
| Allow edits | The agent may create and edit notes |
| Inline assistance | After a pause, prepare a continuation. On by default. Alt+\ inserts it |
| Pause | Milliseconds the note stays still before that request. Default 800 |
| Suggestion length | Most characters a continuation may add. Default 400 |

The composer shows the open note and the current selection as chips. × removes that context from the next message only; the message after that includes them again. A paperclip still pins the selection, and `[[` still pins a note.

**Stop** ends the turn in the panel and keeps whatever had already streamed, followed by "Stopped." Notia cannot cancel the HTTP request, so the model may finish in the background and the rest of the reply is ignored.

**Index the vault** embeds notes so a question can find a passage that does not share its words. Until then, search is by keywords. Indexing again skips notes that have not changed. The index is stored in this plugin's `index/` folder.

**Refresh the index** does that on its own: after a note is created, saved, renamed, or deleted, one pass runs about two seconds later and embeds only the notes that changed. Changing the embedding provider or model runs a pass too, because stored vectors only match the model that made them. The panel shows whether search is semantic or keyword only, and says while the index is updating.

Ollama needs no key. Pull a chat model and an embedding model, for example `nomic-embed-text`, then load models and index.

Anthropic has no embedding API. Pick another embedding provider, or leave embeddings off and search by keywords.

## What the agent can change

It can list notes, read a note, search, create a note, replace an exact passage, append, and insert at the cursor. An edit to the note that is open goes through the editor, so it is one undo step. A continuation from Alt+\ is one undo step too. Turning off **Allow edits** leaves the read and search tools. Continuations do not use those tools.
