import { tool } from "@opencode-ai/plugin";

import { createPassportHooks } from "./plugin.js";

// This is the only module that imports the host. Runtime logic remains
// testable without installing OpenCode or its plugin package.
export const AIPassportPlugin = async (input, options = {}) =>
  (await createPassportHooks({
    rawConfig: options,
    tool,
    project: typeof input?.directory === "string" ? input.directory : null,
  })).hooks;
