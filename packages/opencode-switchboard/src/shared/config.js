import os from "node:os";
import path from "node:path";

// Agent-client config resolution. Every field is optional and every bad value
// falls back to the supplied host default rather than throwing. A client that
// refuses to load on a typo can take the host's whole memory surface down.

export function resolveStateDir(
  env = process.env,
  { stateDirEnvVarName, defaultStateDir } = {}
) {
  const configured =
    typeof stateDirEnvVarName === "string" && typeof env?.[stateDirEnvVarName] === "string"
      ? env[stateDirEnvVarName].trim()
      : "";
  if (configured) return configured;
  if (typeof defaultStateDir !== "string" || !defaultStateDir.trim()) return os.homedir();
  return path.isAbsolute(defaultStateDir) ? defaultStateDir : path.join(os.homedir(), defaultStateDir);
}

const boolean = (value, fallback) => (typeof value === "boolean" ? value : fallback);

const bounded = (value, { min, max, fallback }) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
};

const trimmedString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

// A base URL is only usable if it parses and is http(s). Anything else would
// send a bearer token somewhere unintended.
export function normalizeBaseUrl(value) {
  const raw = trimmedString(value);
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function resolveConfig(
  raw,
  {
    env = process.env,
    logger = null,
    stateDirEnvVarName,
    defaultStateDir,
    governedCategories,
    defaultCategories,
    defaults,
  }
) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const context = source.context && typeof source.context === "object" ? source.context : {};
  const search = source.search && typeof source.search === "object" ? source.search : {};
  const policy = source.policy && typeof source.policy === "object" ? source.policy : {};
  const stateDir = resolveStateDir(env, { stateDirEnvVarName, defaultStateDir });

  const declaredCategories = Array.isArray(source.categories) ? source.categories : [];
  const categories = declaredCategories.filter((entry) => governedCategories.includes(entry));
  const droppedCategories = declaredCategories.filter((entry) => !governedCategories.includes(entry));
  if (droppedCategories.length) {
    logger?.warn?.(
      `ai-passport: ignoring unknown categories in config: ${droppedCategories.map(String).join(", ")}` +
        (categories.length ? "" : "; using the default set")
    );
  }

  return {
    credentialsPath: trimmedString(source.credentialsPath) ?? path.join(stateDir, defaults.credentialsFileName),
    policySnapshotPath:
      trimmedString(source.policySnapshotPath) ?? path.join(stateDir, defaults.policySnapshotFileName),
    baseUrl: normalizeBaseUrl(source.baseUrl),
    mcpServerName: trimmedString(source.mcpServerName) ?? defaults.mcpServerName,
    syncMcpEntry: boolean(source.syncMcpEntry, defaults.syncMcpEntry),
    categories: categories.length ? [...new Set(categories)] : [...defaultCategories],
    cacheTtlMs: bounded(source.cacheTtlMs, { min: 1000, max: 600_000, fallback: defaults.cacheTtlMs }),
    context: {
      enabled: boolean(context.enabled, defaults.context.enabled),
      limit: bounded(context.limit, { min: 1, max: 50, fallback: defaults.context.limit }),
      maxChars: bounded(context.maxChars, { min: 200, max: 20_000, fallback: defaults.context.maxChars }),
      timeoutMs: bounded(context.timeoutMs, { min: 200, max: 10_000, fallback: defaults.context.timeoutMs }),
      sendPromptAsQuery: boolean(context.sendPromptAsQuery, defaults.context.sendPromptAsQuery),
      includeRecent: boolean(context.includeRecent, defaults.context.includeRecent),
    },
    search: {
      enabled: boolean(search.enabled, defaults.search.enabled),
      limit: bounded(search.limit, { min: 1, max: 50, fallback: defaults.search.limit }),
      timeoutMs: bounded(search.timeoutMs, { min: 200, max: 15_000, fallback: defaults.search.timeoutMs }),
    },
    policy: {
      enabled: boolean(policy.enabled, defaults.policy.enabled),
      timeoutMs: bounded(policy.timeoutMs, { min: 200, max: 10_000, fallback: defaults.policy.timeoutMs }),
      approvalWaitMs: bounded(policy.approvalWaitMs, {
        min: 5000,
        max: 600_000,
        fallback: defaults.policy.approvalWaitMs,
      }),
    },
  };
}
