#!/usr/bin/env node

import { passportPaths, resolveConfig } from "./config.js";
import { createHostedTransport } from "./hostedTransport.js";
import { createLocalTransport } from "./localTransport.js";
import { buildStatusReport, formatStatusReport, readStatusFile } from "./status.js";

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("-")) ?? "status";
if (command !== "status") {
  process.stderr.write("Usage: opencode-ai-passport status [--json]\n");
  process.exitCode = 2;
} else {
  const paths = passportPaths();
  const config = resolveConfig();
  const local = createLocalTransport({
    discoveryPath: paths.discoveryPath,
    credentialsPath: paths.credentialsPath,
    timeoutMs: config.ambient.timeoutMs,
  });
  const hosted = createHostedTransport({
    credentialsPath: paths.hostedCredentialsPath,
    timeoutMs: config.ambient.timeoutMs,
  });
  const [localStatus, hostedStatus, persisted] = await Promise.all([
    local.status(),
    hosted.status(),
    readStatusFile(paths.statusPath),
  ]);
  const activeMode = ["local", "hosted", "unavailable"].includes(persisted?.transportKind)
    ? persisted.transportKind
    : "unavailable";
  const activeStatus = activeMode === "hosted" ? hostedStatus : localStatus;
  const transportStatus = {
    ...activeStatus,
    activeMode,
    discoveryFound: localStatus.discoveryFound,
  };
  const report = buildStatusReport({ config, transportStatus, persisted });
  process.stdout.write(`${args.includes("--json") ? JSON.stringify(report) : formatStatusReport(report)}\n`);
}
