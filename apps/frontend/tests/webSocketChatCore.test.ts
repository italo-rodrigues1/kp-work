import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createWsSendMessagePayload,
  requireSuccessfulWsAck,
  shouldClearComposerAfterSend,
} from "../src/hooks/webSocketChatCore.js";

test("o payload WebSocket envia somente IDs para os anexos", () => {
  const payload = createWsSendMessagePayload(
    "workspace-1",
    "thread-1",
    "olá",
    "openai/gpt-4o",
    [{ uploadSessionId: "upload-1" }],
  );

  assert.deepEqual(payload.attachments, [{ uploadSessionId: "upload-1" }]);
  assert.equal(Object.keys(payload.attachments?.[0] ?? {}).length, 1);
  assert.equal(payload.hasAudio, false);
});

test("aceita somente o acknowledgement positivo e do mesmo escopo", () => {
  const ack = {
    ok: true as const,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userMessage: { id: "message-1" },
  };
  assert.equal(
    requireSuccessfulWsAck(ack, "workspace-1", "thread-1"),
    ack,
  );
  assert.throws(
    () =>
      requireSuccessfulWsAck(
        { ok: false, message: "sessão inválida" },
        "workspace-1",
        "thread-1",
      ),
    /sessão inválida/,
  );
  assert.throws(
    () => requireSuccessfulWsAck(ack, "workspace-2", "thread-1"),
    /workspace ou conversa diferente/,
  );
});

test("preserva o composer sem ack e limpa somente depois da confirmação", () => {
  assert.equal(shouldClearComposerAfterSend(false), false);
  assert.equal(shouldClearComposerAfterSend(true), true);
});
