// Status reporting: does this install actually reach the owner's
// Passport, and what is it allowed to read?
//
// Without this there is no way to verify the integration short of reading the
// agent's mind: the explicit memory surface only answers inside a model's
// tool call, and the per-turn block only exists inside a prompt. The
// install guide's verify step and the release-evidence e2e both run this.
//
// It performs exactly what a turn performs (one /agent/prefetch read), so a
// passing status is evidence about the real path, not about a mock.

import { SKIP_REASON_TEXT } from "./format.js";

export function buildStatusReport({
  config,
  result,
  state,
  baseUrl = null,
  policy = null,
  // Local paths are omitted unless a host deliberately exposes them on an
  // owner-only status surface.
  includeLocalPaths = false,
}) {
  const byCategory = new Map();
  for (const row of result?.rows ?? []) {
    byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);
  }
  return {
    ...(includeLocalPaths ? { credentialsPath: config.credentialsPath } : {}),
    baseUrl: baseUrl ?? config.baseUrl,
    categoriesRequested: config.categories,
    surfaces: {
      perTurnContext: config.context.enabled,
      memorySearchCorpus: config.search.enabled,
      toolCallAudit: config.policy.enabled,
    },
    // The tool-policy snapshot the plane answered, or null when the policy
    // surface is off or unreachable (the plane can be older than the plugin).
    policy,
    reachable: Boolean(result),
    stale: Boolean(result?.stale),
    rows: result?.rows?.length ?? 0,
    rowsByCategory: Object.fromEntries(byCategory),
    skipped: (result?.skipped ?? []).map((entry) => ({ ...entry, detail: SKIP_REASON_TEXT[entry.reason] ?? entry.reason })),
    approvalUrl: result?.approvalUrl ?? null,
    backoffReason: state?.backoffReason ?? null,
    terminalReason: state?.terminalReason ?? null,
  };
}

export function formatStatusReport(report, { hostMetadata = {} } = {}) {
  const surfaceLabels = {
    perTurnContext: "per-turn context",
    memorySearchCorpus: "memory corpus",
    toolCallAudit: "tool-call audit",
    ...hostMetadata.surfaceLabels,
  };
  const recoveryInstructions = {
    invalid_grant: "ask the owner for a new connect code and reinstall",
    not_installed: "redeem a connect code first",
    ...hostMetadata.statusRecoveryInstructions,
  };
  const lines = [];
  if (typeof report.credentialsPath === "string") lines.push(`credentials: ${report.credentialsPath}`);
  lines.push(
    `passport:    ${report.baseUrl ?? "(from the credentials file)"}`,
    `surfaces:    ${surfaceLabels.perTurnContext} ${report.surfaces.perTurnContext ? "on" : "off"}, ${surfaceLabels.memorySearchCorpus} ${report.surfaces.memorySearchCorpus ? "on" : "off"}, ${surfaceLabels.toolCallAudit} ${report.surfaces.toolCallAudit ? "on" : "off"}`
  );
  if (report.surfaces.toolCallAudit) {
    lines.push(
      report.policy
        ? `policy:      mode ${report.policy.mode}, ${report.policy.ruleCount} rule(s)`
        : "policy:      not answering (audit reports are skipped until it does)"
    );
  }
  if (report.terminalReason) {
    lines.push(`state:       NOT WORKING (${report.terminalReason})`);
    const instruction = recoveryInstructions[report.terminalReason];
    if (instruction) lines.push(`             ${instruction}`);
    return lines.join("\n");
  }
  if (!report.reachable) {
    if (report.backoffReason === "forbidden") {
      // The client latches this on 403 AND on the 404 a plane-dark deployment
      // answers; both read "closed to this install", never "Passport is down".
      lines.push("state:       forbidden (the agent backend is not open to this install)");
      lines.push("             ask the owner to enable the AI Passport agent backend");
    } else {
      lines.push(`state:       unreachable${report.backoffReason ? ` (${report.backoffReason})` : ""}`);
    }
    return lines.join("\n");
  }
  lines.push(`state:       reachable${report.stale ? " (served from cache)" : ""}`);
  lines.push(`readable:    ${report.rows} row(s)${report.rows ? ` across ${Object.entries(report.rowsByCategory).map(([category, count]) => `${category}=${count}`).join(", ")}` : ""}`);
  if (report.skipped.length) {
    lines.push("awaiting approval:");
    for (const entry of report.skipped) lines.push(`             ${entry.category}: ${entry.detail}`);
    if (report.approvalUrl) lines.push(`             owner approves at ${report.approvalUrl}`);
  } else {
    lines.push("awaiting approval: none");
  }
  return lines.join("\n");
}
