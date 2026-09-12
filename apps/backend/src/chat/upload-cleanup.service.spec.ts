/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { UploadCleanupService } from './upload-cleanup.service';

describe('UploadCleanupService workspace isolation', () => {
  const catalogMock = {
    workspace: { findMany: jest.fn() },
  };
  const tenantA = tenantClient();
  const tenantB = tenantClient();
  const workspaceDatabasesMock = {
    forWorkspace: jest.fn(),
  };
  const storageMock = {
    abortMultipartUpload: jest.fn(),
    deleteUploadedObject: jest.fn(),
    getUploadedObjectMetadata: jest.fn(),
    listMultipartParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    isNotFoundError: jest.fn(),
  };
  const service = new UploadCleanupService(
    catalogMock as never,
    workspaceDatabasesMock as never,
    storageMock as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.UPLOAD_CLEANUP_BATCH_SIZE;
    catalogMock.workspace.findMany.mockResolvedValue([
      { id: 'workspace-default', uploadBucket: 'chat-uploads' },
      { id: 'workspace-b', uploadBucket: 'workspace-b-uploads' },
    ]);
    workspaceDatabasesMock.forWorkspace.mockImplementation(
      (workspaceId: string) =>
        Promise.resolve(
          workspaceId === 'workspace-default' ? tenantA : tenantB,
        ),
    );
    for (const tenant of [tenantA, tenantB]) {
      tenant.uploadSession.findMany.mockResolvedValue([]);
      tenant.uploadSession.updateMany.mockResolvedValue({ count: 1 });
      tenant.uploadSession.deleteMany.mockResolvedValue({ count: 1 });
      tenant.storageDeletionTask.findMany.mockResolvedValue([]);
      tenant.storageDeletionTask.updateMany.mockResolvedValue({ count: 1 });
    }
    storageMock.abortMultipartUpload.mockResolvedValue(undefined);
    storageMock.deleteUploadedObject.mockResolvedValue(undefined);
    storageMock.getUploadedObjectMetadata.mockResolvedValue({
      size: 128,
      contentType: 'text/plain',
    });
    storageMock.isNotFoundError.mockImplementation(
      (error: { $metadata?: { httpStatusCode?: number } }) =>
        error?.$metadata?.httpStatusCode === 404,
    );
  });

  it('filtra sessões e tarefas pelo workspace mesmo no banco catálogo legado', async () => {
    await service.runOnce();

    expect(tenantA.uploadSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: { workspaceId: 'workspace-default' },
        }),
      }),
    );
    expect(tenantA.storageDeletionTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: 'workspace-default' }),
      }),
    );
    expect(tenantB.uploadSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: { workspaceId: 'workspace-b' },
        }),
      }),
    );
    expect(tenantB.storageDeletionTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: 'workspace-b' }),
      }),
    );
  });

  it('respeita o tamanho de lote configurado', async () => {
    process.env.UPLOAD_CLEANUP_BATCH_SIZE = '2';
    catalogMock.workspace.findMany.mockResolvedValue([
      { id: 'workspace-default', uploadBucket: 'chat-uploads' },
    ]);
    tenantA.uploadSession.findMany.mockResolvedValue([
      {
        id: 'upload-1',
        objectKey: 'uploads/1',
        multipartUploadId: null,
        status: 'DELETING',
      },
      {
        id: 'upload-2',
        objectKey: 'uploads/2',
        multipartUploadId: null,
        status: 'DELETING',
      },
    ]);

    await service.runOnce();

    expect(tenantA.uploadSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );
    expect(tenantA.storageDeletionTask.findMany).not.toHaveBeenCalled();
  });

  it('reconcilia uma conclusão abandonada quando o objeto já existe', async () => {
    catalogMock.workspace.findMany.mockResolvedValue([
      { id: 'workspace-default', uploadBucket: 'chat-uploads' },
    ]);
    tenantA.uploadSession.findMany.mockResolvedValue([
      {
        id: 'upload-1',
        objectKey: 'uploads/1',
        size: 128n,
        type: 'text/plain',
        mode: 'SINGLE',
        multipartUploadId: null,
        partSize: null,
        partCount: null,
        status: 'COMPLETING',
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    ]);

    await service.runOnce();

    expect(tenantA.uploadSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'COMPLETING' }),
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
    expect(storageMock.deleteUploadedObject).not.toHaveBeenCalled();
  });

  it('processa tarefa durável e marca a remoção como concluída', async () => {
    catalogMock.workspace.findMany.mockResolvedValue([
      { id: 'workspace-default', uploadBucket: 'chat-uploads' },
    ]);
    tenantA.storageDeletionTask.findMany.mockResolvedValue([
      {
        id: 'task-1',
        workspaceId: 'workspace-default',
        bucket: 'chat-uploads',
        objectKey: 'uploads/deleted/file.pdf',
        multipartUploadId: null,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1),
      },
    ]);

    await service.runOnce();

    expect(storageMock.deleteUploadedObject).toHaveBeenCalledWith(
      'chat-uploads',
      'uploads/deleted/file.pdf',
    );
    expect(tenantA.storageDeletionTask.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PROCESSING',
          attempts: { increment: 1 },
        }),
      }),
    );
    expect(tenantA.storageDeletionTask.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it('reagenda a tarefa quando o storage falha', async () => {
    catalogMock.workspace.findMany.mockResolvedValue([
      { id: 'workspace-default', uploadBucket: 'chat-uploads' },
    ]);
    tenantA.storageDeletionTask.findMany.mockResolvedValue([
      {
        id: 'task-1',
        workspaceId: 'workspace-default',
        bucket: 'chat-uploads',
        objectKey: 'uploads/deleted/file.pdf',
        multipartUploadId: null,
        status: 'PENDING',
        attempts: 1,
        nextAttemptAt: new Date(Date.now() - 1),
      },
    ]);
    storageMock.deleteUploadedObject.mockRejectedValueOnce(
      new Error('storage unavailable'),
    );

    await service.runOnce();

    expect(tenantA.storageDeletionTask.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          lastError: 'storage unavailable',
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
  });
});

function tenantClient() {
  return {
    uploadSession: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    storageDeletionTask: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}
