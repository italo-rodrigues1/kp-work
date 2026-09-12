import { randomUUID } from 'node:crypto';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;
const describeMinio =
  process.env.RUN_MINIO_UPLOAD_INTEGRATION === '1' ? describe : describe.skip;

describeMinio('StorageService MinIO integration', () => {
  jest.setTimeout(60_000);

  const bucket =
    process.env.MINIO_INTEGRATION_BUCKET ||
    process.env.MINIO_CHAT_UPLOAD_BUCKET ||
    'chat-uploads';
  let service: StorageService;

  beforeAll(() => {
    service = new StorageService();
  });

  it('uploads a SINGLE object, validates it and prevents overwriting', async () => {
    const objectKey = `integration/${randomUUID()}/single.bin`;
    const bytes = new TextEncoder().encode('signed upload integration');

    try {
      const uploadUrl = await service.createUploadUrl(
        bucket,
        objectKey,
        'application/octet-stream',
        bytes.byteLength,
        60,
      );
      const firstUpload = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'If-None-Match': '*',
        },
        body: bytes,
      });
      expect(firstUpload.status).toBe(200);

      const metadata = await service.getUploadedObjectMetadata(
        bucket,
        objectKey,
      );
      expect(metadata).toEqual({
        size: bytes.byteLength,
        contentType: 'application/octet-stream',
      });

      const secondUpload = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'If-None-Match': '*',
        },
        body: bytes,
      });
      expect(secondUpload.status).toBe(412);

      const downloadUrl = await service.createDownloadUrl(
        bucket,
        objectKey,
        'single.bin',
        60,
      );
      const downloaded = await fetch(downloadUrl);
      expect(downloaded.status).toBe(200);
      expect(
        Buffer.from(await downloaded.arrayBuffer()).equals(Buffer.from(bytes)),
      ).toBe(true);
    } finally {
      await service.deleteUploadedObject(bucket, objectKey);
    }
  });

  it('uploads, lists and completes a multipart object using server ETags', async () => {
    const objectKey = `integration/${randomUUID()}/multipart.bin`;
    const configuredPartSize = Number(
      process.env.MINIO_INTEGRATION_PART_SIZE_BYTES,
    );
    const partSize = Math.max(
      5 * MIB,
      Number.isSafeInteger(configuredPartSize) && configuredPartSize > 0
        ? configuredPartSize
        : 5 * MIB,
    );
    const chunks = [
      new Uint8Array(partSize).fill(0x61),
      new Uint8Array(1024).fill(0x62),
    ];
    const multipartUploadId = await service.createMultipartUpload(
      bucket,
      objectKey,
      'application/octet-stream',
    );

    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const partNumber = index + 1;
        const uploadUrl = await service.createMultipartPartUploadUrl(
          bucket,
          objectKey,
          multipartUploadId,
          'application/octet-stream',
          partNumber,
          chunks[index].byteLength,
          60,
        );
        const uploaded = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunks[index],
        });
        expect(uploaded.status).toBe(200);
      }

      const storedParts = await service.listMultipartParts(
        bucket,
        objectKey,
        multipartUploadId,
      );
      expect(
        storedParts.map(({ partNumber, size }) => ({ partNumber, size })),
      ).toEqual([
        { partNumber: 1, size: chunks[0].byteLength },
        { partNumber: 2, size: chunks[1].byteLength },
      ]);

      await service.completeMultipartUpload(
        bucket,
        objectKey,
        multipartUploadId,
        storedParts,
      );
      const metadata = await service.getUploadedObjectMetadata(
        bucket,
        objectKey,
      );
      expect(metadata).toEqual({
        size: chunks[0].byteLength + chunks[1].byteLength,
        contentType: 'application/octet-stream',
      });
    } finally {
      await service.abortMultipartUpload(bucket, objectKey, multipartUploadId);
      await service.deleteUploadedObject(bucket, objectKey);
    }
  });
});
