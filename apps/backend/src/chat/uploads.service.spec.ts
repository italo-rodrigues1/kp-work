/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { WorkspaceDatabaseService } from '../workspaces/workspace-database.service';
import { StorageService } from './storage.service';
import { UploadsService } from './uploads.service';

const MIB = 1024 * 1024;

describe('UploadsService', () => {
  const prismaMock = {
    $transaction: jest.fn(),
    thread: {
      findFirst: jest.fn(),
    },
    uploadSession: {
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const workspaceDatabasesMock = {
    forWorkspace: jest.fn(),
    getInfrastructure: jest.fn(),
  };
  const storageMock = {
    createUploadUrl: jest.fn(),
    createMultipartUpload: jest.fn(),
    createMultipartPartUploadUrl: jest.fn(),
    listMultipartParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    isNotFoundError: jest.fn(),
    getUploadedObjectMetadata: jest.fn(),
    createDownloadUrl: jest.fn(),
    deleteUploadedObject: jest.fn(),
  };
  const service = new UploadsService(
    workspaceDatabasesMock as unknown as WorkspaceDatabaseService,
    storageMock as unknown as StorageService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.UPLOAD_SINGLE_MAX_SIZE_BYTES;
    delete process.env.UPLOAD_DOCUMENT_MAX_SIZE_BYTES;
    delete process.env.UPLOAD_DOCUMENT_MAX_FILE_SIZE_BYTES;
    delete process.env.UPLOAD_MAX_FILE_SIZE_BYTES;
    delete process.env.UPLOAD_MEDIA_MAX_SIZE_BYTES;
    delete process.env.UPLOAD_MEDIA_MAX_FILE_SIZE_BYTES;
    delete process.env.UPLOAD_MULTIPART_THRESHOLD_BYTES;
    delete process.env.UPLOAD_MULTIPART_PART_SIZE_BYTES;
    delete process.env.UPLOAD_MAX_ATTACHMENTS;
    delete process.env.UPLOAD_URL_TTL_SECONDS;
    delete process.env.UPLOAD_SESSION_TTL_SECONDS;

    workspaceDatabasesMock.forWorkspace.mockResolvedValue(prismaMock);
    workspaceDatabasesMock.getInfrastructure.mockResolvedValue({
      uploadBucket: 'workspace-upload-bucket',
    });
    prismaMock.thread.findFirst.mockResolvedValue({ id: 'thread-1' });
    prismaMock.uploadSession.count.mockResolvedValue(0);
    prismaMock.$transaction.mockImplementation(
      (callback: (tx: typeof prismaMock) => Promise<unknown>) =>
        callback(prismaMock),
    );
    prismaMock.uploadSession.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.uploadSession.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.uploadSession.create.mockImplementation(
      (query: { data: Record<string, unknown> }) => ({
        ...query.data,
        completedAt: null,
        messageId: null,
        updatedAt: new Date(),
      }),
    );
    storageMock.createUploadUrl.mockResolvedValue('http://minio/upload');
    storageMock.getUploadedObjectMetadata.mockRejectedValue({
      $metadata: { httpStatusCode: 404 },
    });
    storageMock.isNotFoundError.mockImplementation(
      (error: { $metadata?: { httpStatusCode?: number } }) =>
        error?.$metadata?.httpStatusCode === 404,
    );
    storageMock.createMultipartUpload.mockResolvedValue('multipart-1');
    storageMock.createMultipartPartUploadUrl.mockImplementation(
      (_bucket, _key, _uploadId, _contentType, partNumber: number) =>
        `http://minio/part/${partNumber}`,
    );
  });

  it('cria SINGLE para documento no limite e assina tamanho, tipo e não sobrescrita', async () => {
    const result = await service.createSession({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      fileName: 'relatório final.pdf',
      size: 100 * MIB,
      contentType: 'application/pdf',
    });

    expect(result).toMatchObject({
      mode: 'SINGLE',
      category: 'DOCUMENT',
      size: 100 * MIB,
      uploadUrl: 'http://minio/upload',
      uploadHeaders: {
        'Content-Type': 'application/pdf',
        'If-None-Match': '*',
      },
    });
    expect(storageMock.createUploadUrl).toHaveBeenCalledWith(
      'workspace-upload-bucket',
      expect.stringMatching(
        /^uploads\/thread-1\/[0-9a-f-]+\/relatório_final\.pdf$/,
      ),
      'application/pdf',
      100 * MIB,
      900,
    );
    expect(prismaMock.uploadSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ size: BigInt(100 * MIB) }),
      }),
    );
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('cria MULTIPART somente para mídia acima de 100 MiB', async () => {
    const result = await service.createSession({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      fileName: 'filme.mp4',
      size: 101 * MIB,
      contentType: 'video/mp4',
    });

    expect(result).toMatchObject({
      mode: 'MULTIPART',
      category: 'MEDIA',
      partSize: 64 * MIB,
      partCount: 2,
    });
    expect(result.uploadUrl).toBeUndefined();
    expect(storageMock.createMultipartUpload).toHaveBeenCalledWith(
      'workspace-upload-bucket',
      expect.any(String),
      'video/mp4',
    );
  });

  it('recusa documento acima de 100 MiB e mídia acima de 10 GiB', async () => {
    await expect(
      service.createSession({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        fileName: 'grande.pdf',
        size: 100 * MIB + 1,
        contentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createSession({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        fileName: 'grande.mp4',
        size: 10 * 1024 * MIB + 1,
        contentType: 'video/mp4',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(workspaceDatabasesMock.forWorkspace).not.toHaveBeenCalled();
  });

  it('normaliza MIME vazio e recusa arquivo vazio', async () => {
    await expect(
      service.createSession({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        fileName: 'vazio',
        size: 0,
        contentType: '',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const result = await service.createSession({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      fileName: 'arquivo',
      size: 1,
      contentType: '',
    });
    expect(result).toMatchObject({
      type: 'application/octet-stream',
      category: 'DOCUMENT',
    });
  });

  it('recusa a 11ª sessão ativa da conversa', async () => {
    prismaMock.uploadSession.count.mockResolvedValue(10);

    await expect(
      service.createSession({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        fileName: 'arquivo.txt',
        size: 1,
        contentType: 'text/plain',
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(prismaMock.uploadSession.create).not.toHaveBeenCalled();
  });

  it('usa os limites configuráveis documentados', async () => {
    process.env.UPLOAD_DOCUMENT_MAX_FILE_SIZE_BYTES = '8';
    process.env.UPLOAD_MEDIA_MAX_FILE_SIZE_BYTES = '32';
    process.env.UPLOAD_MULTIPART_THRESHOLD_BYTES = '16';
    process.env.UPLOAD_MULTIPART_PART_SIZE_BYTES = '10';
    process.env.UPLOAD_MAX_ATTACHMENTS = '3';

    const multipart = await service.createSession({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      fileName: 'video.mp4',
      size: 17,
      contentType: 'video/mp4',
    });
    expect(multipart).toMatchObject({
      mode: 'MULTIPART',
      partSize: 10,
      partCount: 2,
    });

    prismaMock.uploadSession.count.mockResolvedValue(3);
    await expect(
      service.createSession({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        fileName: 'file.txt',
        size: 8,
        contentType: 'text/plain',
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('repete a transação serializável quando há conflito concorrente', async () => {
    prismaMock.$transaction.mockRejectedValueOnce({ code: 'P2034' });

    await service.createSession({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      fileName: 'file.txt',
      size: 8,
      contentType: 'text/plain',
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });

  it('transforma formatos inválidos de DTO em resposta 400', async () => {
    await expect(
      service.createSession({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        fileName: 123 as unknown as string,
        size: 1,
        contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createSession({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        fileName: 'file.txt',
        size: 1,
        contentType: 123 as unknown as string,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    prismaMock.uploadSession.findFirst.mockResolvedValue(
      sessionRecord({
        mode: 'MULTIPART',
        category: 'MEDIA',
        multipartUploadId: 'multipart-1',
        partSize: 64n,
        partCount: 2,
      }),
    );
    await expect(
      service.createPartUploadUrls(
        'workspace-1',
        'upload-1',
        {} as unknown as number[],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('recusa uma conversa de outro workspace', async () => {
    prismaMock.thread.findFirst.mockResolvedValue(null);

    await expect(
      service.createSession({
        workspaceId: 'workspace-b',
        threadId: 'thread-1',
        fileName: 'arquivo.txt',
        size: 128,
        contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('renova URL SINGLE e estende a sessão', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(
      sessionRecord({ mode: 'SINGLE' }),
    );

    const result = await service.renewUploadUrl('workspace-1', 'upload-1');

    expect(result.uploadUrl).toBe('http://minio/upload');
    expect(prismaMock.uploadSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'upload-1',
          status: 'PENDING',
          mode: 'SINGLE',
        }),
      }),
    );
  });

  it('emite no máximo três URLs multipart com os tamanhos esperados', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(
      sessionRecord({
        mode: 'MULTIPART',
        category: 'MEDIA',
        size: BigInt(101 * MIB),
        type: 'video/mp4',
        multipartUploadId: 'multipart-1',
        partSize: BigInt(64 * MIB),
        partCount: 2,
      }),
    );

    const result = await service.createPartUploadUrls(
      'workspace-1',
      'upload-1',
      [1, 2],
    );

    expect(result.parts.map((part) => part.partNumber)).toEqual([1, 2]);
    expect(storageMock.createMultipartPartUploadUrl).toHaveBeenNthCalledWith(
      1,
      'workspace-upload-bucket',
      expect.any(String),
      'multipart-1',
      'video/mp4',
      1,
      64 * MIB,
      900,
    );
    expect(storageMock.createMultipartPartUploadUrl).toHaveBeenNthCalledWith(
      2,
      'workspace-upload-bucket',
      expect.any(String),
      'multipart-1',
      'video/mp4',
      2,
      37 * MIB,
      900,
    );

    await expect(
      service.createPartUploadUrls('workspace-1', 'upload-1', [1, 1]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('conclui SINGLE somente após reivindicar e validar o objeto', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(sessionRecord());
    storageMock.getUploadedObjectMetadata.mockResolvedValue({
      size: 128,
      contentType: 'text/plain',
    });

    const result = await service.completeSession('workspace-1', 'upload-1');

    expect(result.status).toBe('COMPLETED');
    expect(result.downloadUrl).toBe(
      '/api/uploads/upload-1/download?workspaceId=workspace-1',
    );
    expect(prismaMock.uploadSession.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: { status: 'COMPLETING' } }),
    );
    expect(prismaMock.uploadSession.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it('lista, valida e conclui multipart usando ETags do armazenamento', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(
      sessionRecord({
        mode: 'MULTIPART',
        category: 'MEDIA',
        size: BigInt(101 * MIB),
        type: 'video/mp4',
        multipartUploadId: 'multipart-1',
        partSize: BigInt(64 * MIB),
        partCount: 2,
      }),
    );
    const storedParts = [
      { partNumber: 1, size: 64 * MIB, etag: 'etag-1' },
      { partNumber: 2, size: 37 * MIB, etag: 'etag-2' },
    ];
    storageMock.listMultipartParts.mockResolvedValue(storedParts);
    storageMock.getUploadedObjectMetadata
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
      .mockResolvedValue({
        size: 101 * MIB,
        contentType: 'video/mp4',
      });

    await service.completeSession('workspace-1', 'upload-1');

    expect(storageMock.completeMultipartUpload).toHaveBeenCalledWith(
      'workspace-upload-bucket',
      expect.any(String),
      'multipart-1',
      storedParts,
    );
  });

  it('volta para PENDING quando partes estão ausentes', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(
      sessionRecord({
        mode: 'MULTIPART',
        category: 'MEDIA',
        size: BigInt(101 * MIB),
        type: 'video/mp4',
        multipartUploadId: 'multipart-1',
        partSize: BigInt(64 * MIB),
        partCount: 2,
      }),
    );
    storageMock.listMultipartParts.mockResolvedValue([
      { partNumber: 1, size: 64 * MIB, etag: 'etag-1' },
    ]);

    await expect(
      service.completeSession('workspace-1', 'upload-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prismaMock.uploadSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: 'PENDING' } }),
    );
  });

  it('mantém COMPLETING quando a conclusão multipart tem resposta ambígua', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(
      sessionRecord({
        mode: 'MULTIPART',
        category: 'MEDIA',
        size: BigInt(101 * MIB),
        type: 'video/mp4',
        multipartUploadId: 'multipart-1',
        partSize: BigInt(64 * MIB),
        partCount: 2,
      }),
    );
    storageMock.listMultipartParts.mockResolvedValue([
      { partNumber: 1, size: 64 * MIB, etag: 'etag-1' },
      { partNumber: 2, size: 37 * MIB, etag: 'etag-2' },
    ]);
    const ambiguousFailure = new Error('socket closed after request');
    storageMock.completeMultipartUpload.mockRejectedValueOnce(ambiguousFailure);
    await expect(
      service.completeSession('workspace-1', 'upload-1'),
    ).rejects.toBe(ambiguousFailure);
    expect(prismaMock.uploadSession.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PENDING' } }),
    );
  });

  it('recupera objeto multipart já concluído antes de tentar ListParts', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(
      sessionRecord({
        mode: 'MULTIPART',
        category: 'MEDIA',
        size: BigInt(101 * MIB),
        type: 'video/mp4',
        multipartUploadId: 'multipart-1',
        partSize: BigInt(64 * MIB),
        partCount: 2,
      }),
    );
    storageMock.getUploadedObjectMetadata.mockResolvedValue({
      size: 101 * MIB,
      contentType: 'video/mp4',
    });

    const result = await service.completeSession('workspace-1', 'upload-1');

    expect(result.status).toBe('COMPLETED');
    expect(storageMock.listMultipartParts).not.toHaveBeenCalled();
    expect(storageMock.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('retoma uma conclusão multipart cuja resposta anterior foi perdida', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(
      sessionRecord({
        status: 'COMPLETING',
        mode: 'MULTIPART',
        category: 'MEDIA',
        size: BigInt(101 * MIB),
        type: 'video/mp4',
        multipartUploadId: 'multipart-1',
        partSize: BigInt(64 * MIB),
        partCount: 2,
      }),
    );
    const storedParts = [
      { partNumber: 1, size: 64 * MIB, etag: 'etag-1' },
      { partNumber: 2, size: 37 * MIB, etag: 'etag-2' },
    ];
    storageMock.listMultipartParts.mockResolvedValue(storedParts);
    storageMock.getUploadedObjectMetadata
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
      .mockResolvedValue({ size: 101 * MIB, contentType: 'video/mp4' });

    const result = await service.completeSession('workspace-1', 'upload-1');

    expect(storageMock.completeMultipartUpload).toHaveBeenCalledWith(
      'workspace-upload-bucket',
      expect.any(String),
      'multipart-1',
      storedParts,
    );
    expect(result.status).toBe('COMPLETED');
  });

  it('não ressuscita uma sessão COMPLETING expirada', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(
      sessionRecord({
        status: 'COMPLETING',
        expiresAt: new Date(Date.now() - 1),
      }),
    );

    await expect(
      service.completeSession('workspace-1', 'upload-1'),
    ).rejects.toBeInstanceOf(GoneException);
    expect(storageMock.getUploadedObjectMetadata).not.toHaveBeenCalled();
  });

  it('propaga falha transitória de HEAD sem convertê-la em upload incompleto', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(sessionRecord());
    const unavailable = new Error('MinIO unavailable');
    storageMock.getUploadedObjectMetadata.mockRejectedValueOnce(unavailable);

    await expect(
      service.completeSession('workspace-1', 'upload-1'),
    ).rejects.toBe(unavailable);
  });

  it('recusa renovação expirada e cancelamento concorrente com conclusão', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValueOnce(
      sessionRecord({ expiresAt: new Date(Date.now() - 1) }),
    );
    await expect(
      service.renewUploadUrl('workspace-1', 'upload-1'),
    ).rejects.toBeInstanceOf(GoneException);

    prismaMock.uploadSession.findFirst.mockResolvedValueOnce(
      sessionRecord({ status: 'COMPLETING' }),
    );
    await expect(
      service.cancelSession('workspace-1', 'upload-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('torna o cancelamento idempotente quando a sessão já sumiu', async () => {
    prismaMock.uploadSession.findFirst.mockResolvedValue(null);
    await expect(
      service.cancelSession('workspace-1', 'upload-1'),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(storageMock.deleteUploadedObject).not.toHaveBeenCalled();
  });
});

function sessionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'upload-1',
    threadId: 'thread-1',
    objectKey: 'uploads/thread-1/upload-1/file.txt',
    name: 'file.txt',
    size: 128n,
    type: 'text/plain',
    mode: 'SINGLE',
    category: 'DOCUMENT',
    status: 'PENDING',
    multipartUploadId: null,
    partSize: null,
    partCount: null,
    expiresAt: new Date(Date.now() + 60_000),
    completedAt: null,
    messageId: null,
    updatedAt: new Date(),
    ...overrides,
  };
}
