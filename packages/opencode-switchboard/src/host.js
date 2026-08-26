// Host-owned vocabulary passed into the shared client core.
export const OPENCODE_HOST_METADATA = Object.freeze({
  credentialRecoveryInstruction:
    "Ask the owner for a new connect code and repeat the OpenCode pairing flow.",
  credentialInstallInstruction:
    "Pair this OpenCode install with a connect code from the AI Passport owner app.",
  escalationToolNames: Object.freeze({
    explicitMemoryRead: "passport_recall",
    explicitMemoryWrite: "passport_remember",
  }),
});
