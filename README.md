# AI agent

A chat agent for [Notia](https://github.com/Chakyiu/notia), in the sidebar beside the note you have open. Ask it about the vault, and it can read notes, search them, create a note, and edit one. It does not run commands or delete notes.

The sparkles button above a note opens the panel. `⌘⇧A` does the same (Ctrl+Shift+A on Windows and Linux). **Ask the agent about the selection** adds the selected lines to the chat, shown as the file and the line numbers.

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
| Include the open note | Sends the open note and the selection with the question |
| Search the vault | Attaches a few matching passages |
| Allow edits | The agent may create and edit notes |

**Index the vault** embeds notes so a question can find a passage that does not share its words. Until then, search is by keywords. Indexing again skips notes that have not changed. The index is stored in this plugin's `index/` folder.

Ollama needs no key. Pull a chat model and an embedding model, for example `nomic-embed-text`, then load models and index.

Anthropic has no embedding API. Pick another embedding provider, or leave embeddings off and search by keywords.

## What the agent can change

It can list notes, read a note, search, create a note, replace an exact passage, append, and insert at the cursor. An edit to the note that is open goes through the editor, so it is one undo step. Turning off **Allow edits** leaves the read and search tools.
