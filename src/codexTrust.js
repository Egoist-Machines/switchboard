import { createHash } from "node:crypto";
import path from "node:path";

const encode = (body) => Buffer.from(body, "utf8").toString("base64");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function codexHookTrustedHash(handler) {
  const normalized = {
    type: "command",
    command: handler.command,
    timeout: Math.max(handler.timeout ?? 600, 1),
    async: handler.async ?? false,
  };
  if (Object.hasOwn(handler, "statusMessage")) normalized.statusMessage = handler.statusMessage;
  const identity = canonicalize({ event_name: "user_prompt_submit", hooks: [normalized] });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function codexHookStateKey(hooksJsonPath, groupIndex, handlerIndex) {
  return `${path.resolve(hooksJsonPath)}:user_prompt_submit:${groupIndex}:${handlerIndex}`;
}

export function findSwitchboardHookIndices(configBody, entryB64OrPredicate) {
  const config = typeof configBody === "string" ? JSON.parse(configBody) : configBody;
  const groups = config?.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return null;
  const matchesGroup = typeof entryB64OrPredicate === "string"
    ? (group) => encode(JSON.stringify(group)) === entryB64OrPredicate
    : typeof entryB64OrPredicate === "function"
      ? entryB64OrPredicate
      : () => false;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (!group || !Array.isArray(group.hooks)) continue;
    if (matchesGroup(group, groupIndex)) {
      if (!group.hooks.length) continue;
      return { groupIndex, handlerIndex: 0, handler: group.hooks[0] };
    }
    if (typeof entryB64OrPredicate === "function") {
      for (let handlerIndex = 0; handlerIndex < group.hooks.length; handlerIndex += 1) {
        const handler = group.hooks[handlerIndex];
        if (matchesGroup(handler, groupIndex, handlerIndex)) return { groupIndex, handlerIndex, handler };
      }
    }
  }
  return null;
}

function escapeTomlBasicString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function stateHeader(stateKey) {
  return `[hooks.state."${escapeTomlBasicString(stateKey)}"]`;
}

function linesOf(text) {
  const lines = [];
  let offset = 0;
  while (offset < text.length) {
    const match = /([^\r\n]*)(\r\n|\n|\r|$)/y.exec(text.slice(offset));
    if (!match || !match[0].length) break;
    const start = offset;
    const content = match[1];
    const eol = match[2];
    offset += match[0].length;
    lines.push({ content, eol, start, end: offset });
  }
  return lines;
}

function tableBounds(text, stateKey) {
  const lines = linesOf(text);
  const headerIndex = lines.findIndex((line) => line.content === stateHeader(stateKey));
  if (headerIndex < 0) return null;
  let endIndex = headerIndex + 1;
  while (endIndex < lines.length && !lines[endIndex].content.startsWith("[")) endIndex += 1;
  return { lines, headerIndex, endIndex };
}

function trustedHashValue(line) {
  const match = /^trusted_hash\s*=\s*"((?:\\.|[^"\\])*)"\s*$/.exec(line);
  if (!match) return null;
  return match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

export function readTrustEntry(configTomlText, stateKey) {
  const bounds = tableBounds(configTomlText, stateKey);
  if (!bounds) return null;
  for (let index = bounds.headerIndex + 1; index < bounds.endIndex; index += 1) {
    const value = trustedHashValue(bounds.lines[index].content);
    if (value !== null) return value;
  }
  return null;
}

export function upsertTrustEntry(configTomlText, stateKey, trustedHash) {
  const bounds = tableBounds(configTomlText, stateKey);
  const line = `trusted_hash = "${trustedHash}"`;
  if (!bounds) {
    const header = stateHeader(stateKey);
    if (!configTomlText) return `${header}\n${line}\n`;
    const separator = configTomlText.endsWith("\n") || configTomlText.endsWith("\r") ? "\n" : "\n\n";
    return `${configTomlText}${separator}${header}\n${line}\n`;
  }
  for (let index = bounds.headerIndex + 1; index < bounds.endIndex; index += 1) {
    const current = bounds.lines[index];
    if (trustedHashValue(current.content) !== null) {
      return configTomlText.slice(0, current.start) + line + configTomlText.slice(current.start + current.content.length);
    }
  }
  const header = bounds.lines[bounds.headerIndex];
  const eol = header.eol || "\n";
  if (!header.eol) return `${configTomlText}${eol}${line}${eol}`;
  return configTomlText.slice(0, header.end) + line + eol + configTomlText.slice(header.end);
}

export function removeTrustEntry(configTomlText, stateKey) {
  const bounds = tableBounds(configTomlText, stateKey);
  if (!bounds) return configTomlText;
  const start = bounds.lines[bounds.headerIndex].start;
  const end = bounds.endIndex < bounds.lines.length ? bounds.lines[bounds.endIndex].start : configTomlText.length;
  let before = configTomlText.slice(0, start);
  const after = configTomlText.slice(end);
  if (!after && /(?:\r\n|\n|\r){2}$/.test(before)) {
    before = before.replace(/(?:\r\n|\n|\r)$/, "");
  }
  return before + after;
}
