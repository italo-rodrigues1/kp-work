import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DOCUMENT_MAX_BYTES,
  MAX_TRANSFER_RETRIES,
  MEDIA_MAX_BYTES,
  TransferQueue,
  buildUploadAttachmentPayload,
  calculateUploadProgress,
  classifyUpload,
  hasUploadRetryRemaining,
  isUploadUrlFresh,
  shouldRefreshSingleUploadUrl,
  uploadScopeKey,
  validateUploadFile,
  withAbortTimeout,
} from "../src/hooks/fileUploadCore.js";

test("classifica somente image/audio/video como mídia", () => {
  assert.equal(classifyUpload({ type: "image/png" }), "MEDIA");
  assert.equal(classifyUpload({ type: " AUDIO/mpeg " }), "MEDIA");
  assert.equal(classifyUpload({ type: "video/mp4" }), "MEDIA");
  assert.equal(classifyUpload({ type: "application/pdf" }), "DOCUMENT");
  assert.equal(classifyUpload({ type: "" }), "DOCUMENT");
});

test("aceita os limites exatos e rejeita o byte excedente", () => {
  assert.equal(
    validateUploadFile({
      name: "documento.pdf",
      size: DOCUMENT_MAX_BYTES,
      type: "application/pdf",
    }),
    null,
  );
  assert.match(
    validateUploadFile({
      name: "documento.pdf",
      size: DOCUMENT_MAX_BYTES + 1,
      type: "application/pdf",
    }) ?? "",
    /100 MiB/,
  );
  assert.equal(
    validateUploadFile({
      name: "video.mp4",
      size: MEDIA_MAX_BYTES,
      type: "video/mp4",
    }),
    null,
  );
  assert.match(
    validateUploadFile({
      name: "video.mp4",
      size: MEDIA_MAX_BYTES + 1,
      type: "video/mp4",
    }) ?? "",
    /10 GiB/,
  );
  assert.match(
    validateUploadFile({ name: "vazio.txt", size: 0, type: "text/plain" }) ??
      "",
    /1 byte/,
  );
});

test("monta anexos da mensagem somente com IDs válidos e únicos", () => {
  assert.deepEqual(
    buildUploadAttachmentPayload([
      { name: "a.pdf", uploadSessionId: "upload-1" },
      { name: "b.pdf", uploadSessionId: "upload-2" },
    ]),
    [
      { uploadSessionId: "upload-1" },
      { uploadSessionId: "upload-2" },
    ],
  );
  assert.throws(
    () => buildUploadAttachmentPayload([{ name: "a.pdf" }]),
    /não foi concluído/,
  );
  assert.throws(
    () =>
      buildUploadAttachmentPayload([
        { name: "a.pdf", uploadSessionId: "upload-1" },
        { name: "a.pdf", uploadSessionId: "upload-1" },
      ]),
    /duplicado/,
  );
  assert.throws(
    () =>
      buildUploadAttachmentPayload(
        Array.from({ length: 11 }, (_, index) => ({
          name: `${index}.pdf`,
          uploadSessionId: `upload-${index}`,
        })),
      ),
    /máximo 10/,
  );
});

test("a fila nunca executa mais de três transferências simultâneas", async () => {
  const queue = new TransferQueue(3);
  let active = 0;
  let maximumActive = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const transfers = Array.from({ length: 7 }, (_, index) =>
    queue.schedule(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return index;
    }, new AbortController().signal),
  );

  await Promise.resolve();
  assert.equal(maximumActive, 3);
  release?.();
  assert.deepEqual(await Promise.all(transfers), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(maximumActive, 3);
});

test("abortar um item ainda enfileirado impede sua execução", async () => {
  const queue = new TransferQueue(1);
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = queue.schedule(() => firstGate, new AbortController().signal);

  let secondRan = false;
  const secondController = new AbortController();
  const second = queue.schedule(async () => {
    secondRan = true;
  }, secondController.signal);
  secondController.abort();

  await assert.rejects(
    second,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
  releaseFirst?.();
  await first;
  assert.equal(secondRan, false);
});

test("agrega o progresso das partes e limita o resultado a 100%", () => {
  assert.equal(calculateUploadProgress([32, 16, 16], 128), 50);
  assert.equal(calculateUploadProgress([96, 96], 128), 100);
  assert.equal(calculateUploadProgress([10], 0), 0);
});

test("três retries significam quatro tentativas totais", () => {
  assert.equal(MAX_TRANSFER_RETRIES, 3);
  assert.equal(hasUploadRetryRemaining(0), true);
  assert.equal(hasUploadRetryRemaining(1), true);
  assert.equal(hasUploadRetryRemaining(2), true);
  assert.equal(hasUploadRetryRemaining(3), false);

  let attempts = 0;
  let retriesUsed = 0;
  while (true) {
    attempts += 1;
    if (!hasUploadRetryRemaining(retriesUsed)) break;
    retriesUsed += 1;
  }
  assert.equal(attempts, 4);
});

test("renova URL ausente, expirada ou usada em uma nova tentativa", () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z");
  const fresh = "2026-08-22T12:01:00.000Z";
  const nearExpiry = "2026-08-22T12:00:04.000Z";

  assert.equal(isUploadUrlFresh(fresh, now), true);
  assert.equal(isUploadUrlFresh(nearExpiry, now), false);
  assert.equal(shouldRefreshSingleUploadUrl(undefined, fresh, 0, now), true);
  assert.equal(
    shouldRefreshSingleUploadUrl("https://storage/upload", nearExpiry, 0, now),
    true,
  );
  assert.equal(
    shouldRefreshSingleUploadUrl("https://storage/upload", fresh, 1, now),
    true,
  );
  assert.equal(
    shouldRefreshSingleUploadUrl("https://storage/upload", fresh, 0, now),
    false,
  );
});

test("o escopo do upload muda com workspace ou conversa", () => {
  const original = uploadScopeKey("workspace-1", "thread-1");
  assert.equal(original, uploadScopeKey("workspace-1", "thread-1"));
  assert.notEqual(original, uploadScopeKey("workspace-1", "thread-2"));
  assert.notEqual(original, uploadScopeKey("workspace-2", "thread-1"));
});

test("operações de cancelamento penduradas são abortadas pelo timeout", async () => {
  await assert.rejects(
    withAbortTimeout(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancelado", "AbortError")),
            { once: true },
          );
        }),
      5,
    ),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
});
