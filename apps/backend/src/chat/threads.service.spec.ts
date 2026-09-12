/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { NotFoundException } from '@nestjs/common';
import { ThreadsService } from './threads.service';

describe('ThreadsService workspace isolation', () => {
  const transactionMock = {
    thread: {
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
    storageDeletionTask: {
      createMany: jest.fn(),
    },
  };
  const prismaMock = {
    thread: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const workspaceDatabasesMock = {
    forWorkspace: jest.fn(),
    getInfrastructure: jest.fn(),
  };
  const service = new ThreadsService(workspaceDatabasesMock as never);

  beforeEach(() => {
    jest.clearAllMocks();
    workspaceDatabasesMock.forWorkspace.mockResolvedValue(prismaMock);
    workspaceDatabasesMock.getInfrastructure.mockResolvedValue({
      uploadBucket: 'workspace-a-uploads',
    });
    prismaMock.$transaction.mockImplementation(
      (callback: (tx: typeof transactionMock) => Promise<unknown>) =>
        callback(transactionMock),
    );
  });

  it('lista somente conversas do workspace solicitado', async () => {
    prismaMock.thread.findMany.mockResolvedValue([]);

    await service.findAll('workspace-a');

    expect(prismaMock.thread.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'workspace-a' } }),
    );
  });

  it('serializa tamanhos BigInt ao consultar uma conversa', async () => {
    prismaMock.thread.findFirst.mockResolvedValue({
      id: 'thread-a',
      messages: [
        {
          id: 'message-a',
          attachments: [{ id: 'attachment-a', size: 10_737_418_240n }],
        },
      ],
    });

    const result = await service.findOne('workspace-a', 'thread-a');

    expect(result.messages[0].attachments[0].size).toBe(10_737_418_240);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('grava o workspace na criação da conversa', async () => {
    prismaMock.thread.create.mockImplementation(
      (query: { data: Record<string, unknown> }) => ({
        ...query.data,
        messages: [],
      }),
    );

    await service.create('workspace-a', {
      title: 'Planejamento',
      model: 'openai/gpt-4o',
    });

    expect(prismaMock.thread.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: 'workspace-a' }),
      }),
    );
  });

  it('não encontra uma conversa de outro workspace', async () => {
    prismaMock.thread.findFirst.mockResolvedValue(null);

    await expect(
      service.findOne('workspace-b', 'thread-a'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prismaMock.thread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'thread-a', workspaceId: 'workspace-b' },
      }),
    );
  });

  it('não atualiza uma conversa de outro workspace', async () => {
    prismaMock.thread.findFirst.mockResolvedValue(null);

    await expect(
      service.update('workspace-b', 'thread-a', { title: 'Inválido' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prismaMock.thread.update).not.toHaveBeenCalled();
  });

  it('enfileira deleções duráveis antes do cascade da thread', async () => {
    transactionMock.thread.findFirst.mockResolvedValue({
      id: 'thread-a',
      uploadSessions: [
        {
          objectKey: 'workspaces/a/thread-a/complete.pdf',
          multipartUploadId: null,
        },
        {
          objectKey: 'workspaces/a/thread-a/pending.mp4',
          multipartUploadId: 'multipart-1',
        },
      ],
    });
    transactionMock.storageDeletionTask.createMany.mockResolvedValue({
      count: 2,
    });
    transactionMock.thread.delete.mockResolvedValue({ id: 'thread-a' });

    await expect(service.remove('workspace-a', 'thread-a')).resolves.toEqual({
      id: 'thread-a',
    });

    expect(transactionMock.storageDeletionTask.createMany).toHaveBeenCalledWith(
      {
        data: [
          {
            workspaceId: 'workspace-a',
            bucket: 'workspace-a-uploads',
            objectKey: 'workspaces/a/thread-a/complete.pdf',
            multipartUploadId: null,
          },
          {
            workspaceId: 'workspace-a',
            bucket: 'workspace-a-uploads',
            objectKey: 'workspaces/a/thread-a/pending.mp4',
            multipartUploadId: 'multipart-1',
          },
        ],
        skipDuplicates: true,
      },
    );
    expect(
      transactionMock.storageDeletionTask.createMany.mock
        .invocationCallOrder[0],
    ).toBeLessThan(transactionMock.thread.delete.mock.invocationCallOrder[0]);
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('não apaga uma conversa de outro workspace nem cria tarefas', async () => {
    transactionMock.thread.findFirst.mockResolvedValue(null);

    await expect(
      service.remove('workspace-b', 'thread-a'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(
      transactionMock.storageDeletionTask.createMany,
    ).not.toHaveBeenCalled();
    expect(transactionMock.thread.delete).not.toHaveBeenCalled();
  });
});
