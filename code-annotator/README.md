# code-annotator

A Claude Code plugin that intercepts every file write and opens a live annotation window in your browser — showing Claude's **actual reasoning** extracted directly from the session transcript. Zero extra API calls, zero extra tokens in your coding session.

---

## How it works

```
Claude writes a file
  → PostToolUse hook fires
  → annotate.js reads the live session transcript JSONL
  → extracts Claude's thinking blocks + text explanations
  → detects code structure (functions, classes, imports)
  → matches reasoning to each block
  → writes a self-contained HTML file to /tmp/
  → opens it in your default browser
```

The browser window shows:
- **Code tab** — the written file with syntax highlighting and line numbers. Click any annotation to jump to + highlight that block.
- **Reasoning tab** — Claude's raw extended thinking (purple) and spoken explanation (teal), exactly as it appeared in the session.
- **Annotations sidebar** — each detected code block linked to the most relevant fragment of Claude's reasoning.

---

## Install

### 1. Copy the plugin to your Claude plugins directory

```bash
cp -r code-annotator ~/.claude/plugins/code-annotator
```

### 2. Make the script executable

```bash
chmod +x ~/.claude/plugins/code-annotator/annotate.js
```

### 3. Verify Node.js is available

```bash
node --version  # needs v18+
```

### 4. Load the plugin

**Per-session (for testing):**
```bash
claude --plugin-dir ~/.claude/plugins/code-annotator
```

**Permanently (all projects):**
Inside a Claude Code session, run:
```
/plugin install ~/.claude/plugins/code-annotator
```

---

## Requirements

- Node.js 18+
- Claude Code (any recent version)
- A default browser configured on your OS

No `npm install` needed — the script uses only Node built-ins (`fs`, `path`, `os`, `child_process`).

---

## Extended thinking

The annotation quality is significantly better when Claude uses extended thinking, because the `thinking` blocks in the transcript contain Claude's step-by-step reasoning about *why* it wrote each piece of code.

To enable extended thinking in Claude Code:
```bash
claude --model claude-sonnet-4-5  # or opus — both support extended thinking
```

Without extended thinking, the plugin falls back to Claude's spoken text explanations (the text blocks it writes before making tool calls), which still give useful context.

---

## Customising

All logic is in `annotate.js`. Key areas to tweak:

| Section | What to change |
|---|---|
| `detectCodeBlocks()` | Add patterns for more languages (Go, Ruby, Rust, etc.) |
| `findRelevantContext()` | Tune the scoring to better match reasoning to code blocks |
| `highlightCode()` | Extend syntax highlighting for more file types |
| `buildThinkingPanel()` | Change how thinking vs text blocks are rendered |
| HTML `<style>` | Retheme the annotation window entirely |

**To skip certain file types**, add at the top of the script after parsing `fileInfo`:
```js
const SKIP_EXTENSIONS = new Set(['.json', '.lock', '.md', '.yaml']);
if (SKIP_EXTENSIONS.has(path.extname(fileInfo.filePath))) process.exit(0);
```

**To reuse the same browser tab** instead of opening a new one each time, write to a fixed path:
```js
const tmpFile = path.join(os.homedir(), '.claude', 'annotator-latest.html');
```
Then pin that file as a tab in your browser.

---

## Troubleshooting

**Nothing opens:**
- Check Node is on your PATH: `which node`
- Run the script manually to see errors: `echo '{}' | node ~/.claude/plugins/code-annotator/annotate.js`

**Reasoning panel is empty:**
- Extended thinking may not be enabled. Try with `--model claude-sonnet-4-5`
- The transcript may not have been written yet for very fast writes. This is rare.

**Wrong file shown:**
- For MultiEdit operations, only the first affected file is shown in the Code tab. All files are listed in the Files tab.
