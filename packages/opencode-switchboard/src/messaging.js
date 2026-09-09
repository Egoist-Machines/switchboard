import { setTimeout as delay } from "node:timers/promises";

// Both delivery paths share this queue. A prompt fallback cannot race a push call.
export function createMessagingDelivery({ transport, client }) {
  let sessionId = null;
  let pushing = false;
  let queue = Promise.resolve();
  const controller = new AbortController();
  const exclusive = fn => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  const acknowledge = message => transport.ackMessage({ message_id: message.message_id });
  const release = async message => { try { await transport.releaseMessage({ message_id: message.message_id }); } catch {} };
  const delivery = async () => {
    try { await transport.startMessagingRelay?.(); } catch {}
    while (!controller.signal.aborted) {
      if (sessionId && client?.session?.prompt) {
        await exclusive(async () => {
          if (!sessionId || controller.signal.aborted) return;
          const target = sessionId;
          const result = await transport.receiveMessages({ limit: 1, wait_ms: 1000, timeoutMs: 3000 });
          for (const message of result.messages ?? []) {
            if (controller.signal.aborted || sessionId !== target) { await release(message); continue; }
            let accepted = false;
            try {
              pushing = true;
              const response = await client.session.prompt({ path: { id: target }, body: { parts: [{ type: "text", text: message.envelope }] } });
              if (response?.error) throw new Error("prompt_refused");
              accepted = true;
              await acknowledge(message);
            } catch {
              // Once accepted, an ack failure must not inject the prompt again.
              if (!accepted) await release(message);
            } finally { pushing = false; }
          }
        }).catch(() => {});
      }
      await delay(500, undefined, { signal: controller.signal, ref: false }).catch(() => {});
    }
  };
  const running = delivery();
  return {
    async event({ event }) {
      const properties = event?.properties;
      if (event?.type === "session.deleted" && properties?.info?.id === sessionId) sessionId = null;
      else {
        const id = properties?.sessionID ?? properties?.info?.sessionID ??
          (event?.type === "session.created" ? properties?.info?.id : null);
        if (typeof id === "string" && id) sessionId = id;
      }
    },
    async chat(input) { if (typeof input?.sessionID === "string" && input.sessionID) sessionId = input.sessionID; },
    async fallback(_input, output) {
      if (pushing || !Array.isArray(output?.system)) return;
      await exclusive(async () => {
        const result = await transport.receiveMessages({ limit: 10, wait_ms: 0, max_chars: 2000, timeoutMs: 1500 });
        const messages = result.messages ?? [];
        if (!messages.length) return;
        try {
          output.system.push(`<ai-passport-messages>\n${messages.map(m => m.envelope).join("\n")}\n</ai-passport-messages>`);
        } catch { for (const message of messages) await release(message); return; }
        for (const message of messages) { try { await acknowledge(message); } catch {} }
      });
    },
    async dispose() { controller.abort(); await running; },
  };
}
