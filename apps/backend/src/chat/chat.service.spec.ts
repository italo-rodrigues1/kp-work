/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { EventsService } from './events.service';
import { RabbitMQService } from './rabbitmq.service';
import { StorageService } from './storage.service';

interface UploadRecord {
  id: string;
  threadId: string;
  messageId: string | null;
  name: string;
  size: bigint;
  type: string;
  status: string;
  expiresAt: Date;
}

interface MessageCreateQuery {
  data: {
    attachments?: {
      create: Array<{
        name: string;
        size: bigint;
        type: string;
        url: string;
      }>;
    };
  };
}

interface UploadUpdateQuery {
  where: Record<string, unknown>;
  data: {
    status: string;
    messageId: string;
    attachedAt: Date;
  };
}

describe('ChatService uploads', () => {
  let capturedCreateQuery: MessageCreateQuery | undefined;
  let capturedUpdateQuery: UploadUpdateQuery | undefined;
  const transactionMock = {
    uploadSession: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    message: {
      create: jest.fn(),
    },
  };
  const prismaMock = {
    thread: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    message: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const workspaceDatabasesMock = {
    forWorkspace: jest.fn(),
    getInfrastructure: jest.fn(),
  };
  const storageMock = {
    saveAgentContext: jest.fn(),
  };
  const rabbitMock = {
    dispatchTask: jest.fn(),
  };
  const service = new ChatService(
    workspaceDatabasesMock as never,
    {} as EventsService,
    storageMock as unknown as StorageService,
    rabbitMock as unknown as RabbitMQService,
  );

  const validUpload = (
    overrides: Partial<UploadRecord> = {},
  ): UploadRecord => ({
    id: 'upload-1',
    threadId: 'thread-1',
    messageId: null,
    name: 'arquivo.pdf',
    size: 128n,
    type: 'application/pdf',
    status: 'COMPLETED',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.UPLOAD_MAX_ATTACHMENTS;
    capturedCreateQuery = undefined;
    capturedUpdateQuery = undefined;
    workspaceDatabasesMock.forWorkspace.mockResolvedValue(prismaMock);
    workspaceDatabasesMock.getInfrastructure.mockResolvedValue({
      contextBucket: 'workspace-contexts',
    });
    prismaMock.thread.findFirst.mockResolvedValue({ id: 'thread-1' });
    prismaMock.message.findMany.mockResolvedValue([]);
    prismaMock.message.findFirst.mockResolvedValue({ id: 'message-1' });
    prismaMock.message.upsert.mockResolvedValue({
      id: 'agent-response:message-1',
      content: 'Resposta',
      attachments: [],
      audio: null,
      createdAt: new Date(),
    });
    prismaMock.thread.update.mockResolvedValue({ id: 'thread-1' });
    storageMock.saveAgentContext.mockResolvedValue('context.json');
    rabbitMock.dispatchTask.mockResolvedValue(true);
    prismaMock.$transaction.mockImplementation(
      (callback: (tx: typeof transactionMock) => Promise<unknown>) =>
        callback(transactionMock),
    );
    transactionMock.message.create.mockImplementation(
      (query: MessageCreateQuery) => {
        capturedCreateQuery = query;
        return Promise.resolve({
          id: 'message-1',
          content: 'Veja o anexo',
          attachments: [{ id: 'attachment-1', size: 128n }],
          audio: null,
          createdAt: new Date(),
        });
      },
    );
    transactionMock.uploadSession.updateMany.mockImplementation(
      (query: UploadUpdateQuery) => {
        capturedUpdateQuery = query;
        return Promise.resolve({ count: 1 });
      },
    );
  });

  it('consome uploads concluídos na mesma transação e serializa BigInt', async () => {
    transactionMock.uploadSession.findMany.mockResolvedValue([validUpload()]);

    const result = await service.saveUserMessage({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      message: 'Veja o anexo',
      model: 'openai/gpt-4o',
      attachments: [{ uploadSessionId: 'upload-1' }],
    });

    expect(result.userMessage.id).toBe('message-1');
    expect(result.userMessage.attachments[0].size).toBe(128);
    expect(capturedCreateQuery?.data.attachments).toEqual({
      create: [
        {
          name: 'arquivo.pdf',
          size: 128n,
          type: 'application/pdf',
          url: '/api/uploads/upload-1/download?workspaceId=workspace-1',
        },
      ],
    });
    expect(capturedUpdateQuery?.data.status).toBe('ATTACHED');
    expect(capturedUpdateQuery?.data.messageId).toBe('message-1');
    expect(capturedUpdateQuery?.data.attachedAt).toBeInstanceOf(Date);
    expect(capturedUpdateQuery?.where).toEqual(
      expect.objectContaining({
        threadId: 'thread-1',
        status: 'COMPLETED',
        messageId: null,
      }),
    );
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('mantém a ordem dos IDs enviada pelo cliente', async () => {
    transactionMock.uploadSession.findMany.mockResolvedValue([
      validUpload({ id: 'upload-2', name: 'segundo.txt' }),
      validUpload({ id: 'upload-1', name: 'primeiro.txt' }),
    ]);
    transactionMock.uploadSession.updateMany.mockResolvedValue({ count: 2 });

    await service.saveUserMessage({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      attachments: [
        { uploadSessionId: 'upload-1' },
        { uploadSessionId: 'upload-2' },
      ],
    });

    expect(
      capturedCreateQuery?.data.attachments?.create.map(({ name }) => name),
    ).toEqual(['primeiro.txt', 'segundo.txt']);
  });

  it('recusa mais de dez anexos e IDs duplicados', async () => {
    await expect(
      service.saveUserMessage({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        attachments: Array.from({ length: 11 }, (_, index) => ({
          uploadSessionId: `upload-${index}`,
        })),
      }),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_ATTACHMENT_LIMIT_EXCEEDED' },
    });

    await expect(
      service.saveUserMessage({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        attachments: [
          { uploadSessionId: 'upload-1' },
          { uploadSessionId: 'upload-1' },
        ],
      }),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_ATTACHMENT_IDS_DUPLICATED' },
    });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('respeita um limite configurado de anexos sem ultrapassar o teto absoluto', async () => {
    process.env.UPLOAD_MAX_ATTACHMENTS = '2';

    await expect(
      service.saveUserMessage({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        attachments: [
          { uploadSessionId: 'upload-1' },
          { uploadSessionId: 'upload-2' },
          { uploadSessionId: 'upload-3' },
        ],
      }),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_ATTACHMENT_LIMIT_EXCEEDED' },
    });

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('recusa upload inexistente ou pertencente a outra conversa', async () => {
    transactionMock.uploadSession.findMany.mockResolvedValue([
      validUpload({ threadId: 'thread-2' }),
    ]);

    await expect(
      service.saveUserMessage({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        message: 'Anexo',
        attachments: [{ uploadSessionId: 'upload-1' }],
      }),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_SESSION_INVALID_SCOPE' },
    });

    expect(transactionMock.message.create).not.toHaveBeenCalled();
  });

  it('recusa sessão expirada com código estável', async () => {
    transactionMock.uploadSession.findMany.mockResolvedValue([
      validUpload({ expiresAt: new Date(Date.now() - 1) }),
    ]);

    const promise = service.saveUserMessage({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      attachments: [{ uploadSessionId: 'upload-1' }],
    });
    await expect(promise).rejects.toBeInstanceOf(GoneException);
    await expect(promise).rejects.toMatchObject({
      response: { code: 'UPLOAD_SESSION_EXPIRED' },
    });
  });

  it('recusa sessão que não está concluída', async () => {
    transactionMock.uploadSession.findMany.mockResolvedValue([
      validUpload({ status: 'PENDING' }),
    ]);

    await expect(
      service.saveUserMessage({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        attachments: [{ uploadSessionId: 'upload-1' }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(transactionMock.message.create).not.toHaveBeenCalled();
  });

  it('reverte a mensagem quando perde a corrida para anexar', async () => {
    transactionMock.uploadSession.findMany.mockResolvedValue([validUpload()]);
    transactionMock.uploadSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.saveUserMessage({
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        attachments: [{ uploadSessionId: 'upload-1' }],
      }),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_SESSION_CONFLICT' },
    });
  });

  it('recusa uma conversa pertencente a outro workspace', async () => {
    prismaMock.thread.findFirst.mockResolvedValue(null);

    await expect(
      service.saveUserMessage({
        workspaceId: 'workspace-b',
        threadId: 'thread-1',
        message: 'Não deve entrar',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it('exige workspace em toda mensagem', async () => {
    await expect(
      service.saveUserMessage({
        threadId: 'thread-1',
        message: 'Sem workspace',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(workspaceDatabasesMock.forWorkspace).not.toHaveBeenCalled();
  });

  it('despacha somente histórico e bucket de contexto da workspace', async () => {
    prismaMock.message.findMany.mockResolvedValue([
      { sender: 'user', content: 'Olá' },
    ]);

    await expect(
      service.dispatchToAgentTimeline(
        'workspace-1',
        'thread-1',
        'message-1',
        'Olá',
      ),
    ).resolves.toBe(true);

    expect(prismaMock.message.findMany).toHaveBeenCalledWith({
      where: {
        threadId: 'thread-1',
        thread: { workspaceId: 'workspace-1' },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    expect(storageMock.saveAgentContext).toHaveBeenCalledWith(
      'workspace-contexts',
      expect.stringContaining('workspace-1/thread-1/message-1.json'),
      expect.objectContaining({
        workspaceId: 'workspace-1',
        chatHistory: [{ sender: 'user', content: 'Olá' }],
      }),
    );
    expect(rabbitMock.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        blobBucket: 'workspace-contexts',
      }),
    );
    expect(rabbitMock.dispatchTask.mock.calls[0][0]).not.toHaveProperty(
      'callbackUrl',
    );
  });

  it('vincula o callback à mensagem de usuário da mesma workspace', async () => {
    await expect(
      service.ensureUserMessageInWorkspace(
        'workspace-1',
        'thread-1',
        'message-1',
      ),
    ).resolves.toEqual({ id: 'message-1' });

    expect(prismaMock.message.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'message-1',
        sender: 'user',
        thread: { id: 'thread-1', workspaceId: 'workspace-1' },
      },
      select: { id: true },
    });
  });

  it('torna a conclusão do agente idempotente por mensagem de usuário', async () => {
    await service.saveAssistantMessage(
      'workspace-1',
      'thread-1',
      'Resposta',
      'openai/gpt-4o',
      'message-1',
    );

    expect(prismaMock.message.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'agent-response:message-1' },
        create: expect.objectContaining({
          id: 'agent-response:message-1',
          threadId: 'thread-1',
          sender: 'assistant',
        }),
        update: expect.objectContaining({
          threadId: 'thread-1',
          sender: 'assistant',
          content: 'Resposta',
        }),
      }),
    );
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });
});
