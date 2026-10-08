#!/usr/bin/env node
/**
 * code-annotator/annotate.js
 *
 * Fires after every Write / Edit / MultiEdit tool call.
 * Reads Claude's actual reasoning from the live session transcript (no extra API call),
 * then opens a self-contained HTML annotation window in the default browser.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
// child_process no longer needed — VS Code extension handles display

// ─── 1. Read hook payload from stdin ────────────────────────────────────────
let raw = '';
try {
  raw = fs.readFileSync('/dev/stdin', 'utf8');
} catch {
  process.exit(0); // nothing on stdin, bail silently
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const {
  transcript_path,
  tool_name,
  tool_input = {},
} = payload;

// Only care about file-write tools
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
if (!WRITE_TOOLS.has(tool_name)) process.exit(0);

// ─── 2. Extract file info from the tool input ────────────────────────────────
function getFileInfo(toolName, input) {
  if (toolName === 'MultiEdit') {
    // MultiEdit has { edits: [{ file_path, old_string, new_string }] }
    const files = [...new Set((input.edits || []).map(e => e.file_path).filter(Boolean))];
    return { filePath: files.join(', '), content: null, isMulti: true, files };
  }
  return {
    filePath: input.file_path || input.path || 'unknown',
    content: input.content || input.new_string || null,
    isMulti: false,
    files: [],
  };
}

const fileInfo = getFileInfo(tool_name, tool_input);

// Read the actual file content from disk (most reliable source)
function readFileContent(fp) {
  try {
    if (fp && fs.existsSync(fp)) return fs.readFileSync(fp, 'utf8');
  } catch {}
  return null;
}

// ─── 3. Parse the transcript JSONL ───────────────────────────────────────────
function parseTranscript(transcriptPath) {
  if (!transcriptPath) return [];
  try {
    const text = fs.readFileSync(transcriptPath.replace(/^~/, os.homedir()), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const entries = parseTranscript(transcript_path);

// ─── 4. Find Claude's reasoning just before this tool call ───────────────────
// Transcript entries look like:
//   { type: "message", role: "assistant", content: [...blocks] }
//   { type: "tool_use", ... }   ← this is the Write/Edit call we just came from
//
// We want the LAST assistant message before the most recent tool_use for our tool.

function extractAssistantContext(entries, toolName) {
  // Walk backwards through entries
  let foundToolUse = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    // Transcript entries may nest the message under entry.message (Claude Code format)
    const role    = entry.role    ?? entry.message?.role;
    const content = entry.content ?? entry.message?.content;

    // Skip until we find the tool_use that matches
    if (!foundToolUse) {
      if (
        (entry.type === 'tool_use' || entry.tool_name === toolName) &&
        (entry.tool_name === toolName || entry.name === toolName)
      ) {
        foundToolUse = true;
      }
      // Also check inside assistant messages for tool_use blocks
      if (role === 'assistant' && Array.isArray(content)) {
        const tu = content.find(
          b => b.type === 'tool_use' && WRITE_TOOLS.has(b.name)
        );
        if (tu) {
          // Extract context from THIS message (thinking + text blocks before the tool_use)
          return extractBlocksFromMessage(content, tu.id);
        }
      }
      continue;
    }

    // Now look for the preceding assistant message
    if (role === 'assistant' && Array.isArray(content)) {
      return extractBlocksFromMessage(content, null);
    }
  }
  return { thinking: [], text: [] };
}

function extractBlocksFromMessage(contentBlocks, stopAtToolUseId) {
  const thinking = [];
  const text = [];

  for (const block of contentBlocks) {
    if (stopAtToolUseId && block.type === 'tool_use' && block.id === stopAtToolUseId) break;

    if (block.type === 'thinking' && block.thinking) {
      thinking.push(block.thinking);
    } else if (block.type === 'text' && block.text) {
      text.push(block.text);
    }
  }
  return { thinking, text };
}

const context = extractAssistantContext(entries, tool_name);

// ─── 5. Build per-line annotations from the content ──────────────────────────
function buildLineAnnotations(fileContent, thinkingBlocks, textBlocks) {
  if (!fileContent) return [];

  const lines = fileContent.split('\n');
  const annotations = [];

  // Simple heuristic: scan thinking/text for line references or code patterns
  // and attach them. For now we produce a structured breakdown by code section.
  const allContext = [...thinkingBlocks, ...textBlocks].join('\n\n');

  // Detect block boundaries (functions, classes, imports, etc.)
  const blockRanges = detectCodeBlocks(lines);

  for (const block of blockRanges) {
    annotations.push({
      startLine: block.start,
      endLine: block.end,
      label: block.label,
      type: block.type,
      // Pull relevant snippet from Claude's reasoning if it mentions this block
      explanation: findRelevantContext(allContext, block.label, lines.slice(block.start - 1, block.end).join('\n')),
    });
  }

  return annotations;
}

function detectCodeBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    const lineNum = i + 1;

    // Import/require blocks
    if (/^(import |from |const .* = require|require\()/.test(line)) {
      let end = i;
      while (end + 1 < lines.length && /^(import |from |const .* = require|require\()/.test(lines[end + 1].trim())) {
        end++;
      }
      if (end > i || line.length > 5) {
        blocks.push({ start: lineNum, end: end + 1, label: 'Imports / dependencies', type: 'import' });
        i = end + 1;
        continue;
      }
    }

    // Class declarations
    if (/^(export\s+)?(abstract\s+)?class\s+\w+/.test(line)) {
      const end = findBlockEnd(lines, i);
      const name = line.match(/class\s+(\w+)/)?.[1] || 'class';
      blocks.push({ start: lineNum, end, label: `Class: ${name}`, type: 'class' });
      i = end;
      continue;
    }

    // Function / method declarations
    if (/^(export\s+)?(async\s+)?function\s+\w+|^\s*(async\s+)?\w+\s*[=:]\s*(async\s+)?\(/.test(line) ||
        /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?(\(|function)/.test(line)) {
      const end = findBlockEnd(lines, i);
      const name = line.match(/function\s+(\w+)/) ||
                   line.match(/const\s+(\w+)/) ||
                   line.match(/(\w+)\s*[:=]/);
      const label = name ? `Function: ${name[1]}` : 'Function block';
      if (end > lineNum) {
        blocks.push({ start: lineNum, end, label, type: 'function' });
        i = end;
        continue;
      }
    }

    // Interface / type declarations (TS)
    if (/^(export\s+)?(interface|type)\s+\w+/.test(line)) {
      const end = findBlockEnd(lines, i);
      const name = line.match(/(interface|type)\s+(\w+)/)?.[2] || 'type';
      blocks.push({ start: lineNum, end, label: `Type: ${name}`, type: 'type' });
      i = end;
      continue;
    }

    i++;
  }

  // If no blocks detected, fall back to grouping every N lines
  if (blocks.length === 0 && lines.length > 0) {
    const chunkSize = Math.min(10, Math.ceil(lines.length / 4));
    for (let start = 1; start <= lines.length; start += chunkSize) {
      blocks.push({
        start,
        end: Math.min(start + chunkSize - 1, lines.length),
        label: `Lines ${start}–${Math.min(start + chunkSize - 1, lines.length)}`,
        type: 'chunk',
      });
    }
  }

  return blocks;
}

function findBlockEnd(lines, startIdx) {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') depth--;
    }
    if (started && depth === 0) return i + 1;
  }
  return lines.length;
}

function findRelevantContext(fullContext, blockLabel, codeSnippet) {
  if (!fullContext.trim()) return null;

  // Extract a function/variable name from the block label
  const nameMatch = blockLabel.match(/:\s*(\w+)/);
  const name = nameMatch?.[1];

  // Score each sentence in the context by relevance
  const sentences = fullContext.split(/(?<=[.!?])\s+|\n{2,}/);
  const scored = sentences.map(s => {
    let score = 0;
    if (name && s.includes(name)) score += 3;
    if (s.includes(blockLabel)) score += 2;
    // Check if any code token appears
    const codeTokens = codeSnippet.match(/\b\w{3,}\b/g) || [];
    for (const tok of codeTokens.slice(0, 20)) {
      if (s.includes(tok)) score += 0.5;
    }
    return { s, score };
  });

  const best = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  return best.length > 0 ? best.slice(0, 3).map(x => x.s.trim()).join(' ') : null;
}

// ─── 6. Read file content ────────────────────────────────────────────────────
let primaryContent = null;
let primaryPath = fileInfo.filePath;

if (!fileInfo.isMulti) {
  primaryContent = readFileContent(fileInfo.filePath) || fileInfo.content;
} else {
  // For MultiEdit, show the first affected file
  primaryPath = fileInfo.files[0] || fileInfo.filePath;
  primaryContent = readFileContent(primaryPath);
}

const lineAnnotations = buildLineAnnotations(primaryContent, context.thinking, context.text);

// ─── 7. Write JSON for VS Code extension ─────────────────────────────────────
const timestamp = new Date().toLocaleTimeString();
const shortPath = fileInfo.filePath.replace(os.homedir(), '~');

const annotationData = {
  timestamp,
  toolName: tool_name,
  filePath: fileInfo.filePath,
  shortPath,
  isMulti: fileInfo.isMulti,
  files: fileInfo.files,
  content: primaryContent || '',
  annotations: lineAnnotations,
  thinking: context.thinking,
  text: context.text,
};

const dataFile = path.join(os.homedir(), '.claude', 'annotator-latest.json');
fs.writeFileSync(dataFile, JSON.stringify(annotationData), 'utf8');

process.exit(0);
