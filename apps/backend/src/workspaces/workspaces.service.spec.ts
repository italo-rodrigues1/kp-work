/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { StorageService } from '../chat/storage.service';
import { PrismaService } from '../prisma.service';
import { WorkspaceDatabaseService } from './workspace-database.service';
import { WorkspacesService } from './workspaces.service';

describe('WorkspacesService', () => {
  const now = new Date('2026-08-22T12:00:00.000Z');
  const prismaMock = {
    workspace: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const tenantMock = {
    thread: { count: jest.fn() },
    workspace: { update: jest.fn() },
  };
  const databaseMock = {
    forWorkspace: jest.fn(),
    provisionWorkspaceDatabase: jest.fn(),
    removeWorkspaceDatabase: jest.fn(),
  };
  const storageMock = {
    provisionWorkspaceStorage: jest.fn(),
    removeWorkspaceStorage: jest.fn(),
  };
  const service = new WorkspacesService(
    prismaMock as unknown as PrismaService,
    databaseMock as unknown as WorkspaceDatabaseService,
    storageMock as unknown as StorageService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    databaseMock.forWorkspace.mockResolvedValue(tenantMock);
    tenantMock.thread.count.mockResolvedValue(0);
    databaseMock.provisionWorkspaceDatabase.mockResolvedValue(undefined);
    databaseMock.removeWorkspaceDatabase.mockResolvedValue(undefined);
    storageMock.provisionWorkspaceStorage.mockResolvedValue(undefined);
    storageMock.removeWorkspaceStorage.mockResolvedValue(undefined);
  });

  it('garante o workspace pessoal e conta threads no banco físico', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue(null);
    prismaMock.workspace.create.mockResolvedValue({ id: 'workspace-default' });
    prismaMock.workspace.findMany.mockResolvedValue([
      {
        id: 'workspace-default',
        name: 'Pessoal',
        color: '#f97316',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    tenantMock.thread.count.mockResolvedValue(3);

    const result = await service.findAll();

    expect(prismaMock.workspace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'workspace-default',
        status: 'READY',
      }),
    });
    expect(prismaMock.workspace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'READY' } }),
    );
    expect(databaseMock.forWorkspace).toHaveBeenCalledWith('workspace-default');
    expect(result[0]._count.threads).toBe(3);
  });

  it('sincroniza os buckets legados da workspace padrão com o ambiente', async () => {
    const originalUploadBucket = process.env.MINIO_CHAT_UPLOAD_BUCKET;
    const originalContextBucket = process.env.MINIO_AGENT_CONTEXT_BUCKET;
    process.env.MINIO_CHAT_UPLOAD_BUCKET = 'custom-chat-uploads';
    process.env.MINIO_AGENT_CONTEXT_BUCKET = 'custom-agent-contexts';
    prismaMock.workspace.findUnique.mockResolvedValue({
      id: 'workspace-default',
      databaseName: 'chat_ai',
      uploadBucket: 'chat-uploads',
      contextBucket: 'agent-contexts',
      status: 'READY',
      provisioningError: null,
    });
    prismaMock.workspace.update.mockResolvedValue({});

    try {
      await service.onModuleInit();
    } finally {
      if (originalUploadBucket === undefined) {
        delete process.env.MINIO_CHAT_UPLOAD_BUCKET;
      } else {
        process.env.MINIO_CHAT_UPLOAD_BUCKET = originalUploadBucket;
      }
      if (originalContextBucket === undefined) {
        delete process.env.MINIO_AGENT_CONTEXT_BUCKET;
      } else {
        process.env.MINIO_AGENT_CONTEXT_BUCKET = originalContextBucket;
      }
    }

    expect(prismaMock.workspace.update).toHaveBeenCalledWith({
      where: { id: 'workspace-default' },
      data: expect.objectContaining({
        uploadBucket: 'custom-chat-uploads',
        contextBucket: 'custom-agent-contexts',
        status: 'READY',
      }),
    });
  });

  it('provisiona banco e buckets antes de publicar o workspace como READY', async () => {
    prismaMock.workspace.create.mockResolvedValue({});
    prismaMock.workspace.update.mockImplementation(
      (query: { data: { status: string } }) => ({
        id: 'created',
        name: 'Marketing',
        color: '#8b5cf6',
        createdAt: now,
        updatedAt: now,
        status: query.data.status,
      }),
    );

    const result = await service.create({
      name: '  Marketing  ',
      color: '#8B5CF6',
    });

    const createData = prismaMock.workspace.create.mock.calls[0][0].data;
    expect(createData.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(createData.databaseName).toMatch(/^chat_ai_ws_[0-9a-f]{32}$/);
    expect(createData.uploadBucket).toMatch(
      /^chat-ai-ws-[0-9a-f]{32}-uploads$/,
    );
    expect(databaseMock.provisionWorkspaceDatabase).toHaveBeenCalledTimes(1);
    expect(storageMock.provisionWorkspaceStorage).toHaveBeenCalledTimes(1);
    expect(prismaMock.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'READY', provisioningError: null },
      }),
    );
    expect(result).toEqual(expect.objectContaining({ _count: { threads: 0 } }));
  });

  it('compensa recursos e registra FAILED quando o provisionamento falha', async () => {
    prismaMock.workspace.create.mockResolvedValue({});
    storageMock.provisionWorkspaceStorage.mockRejectedValue(
      new Error('storage unavailable'),
    );
    prismaMock.workspace.update.mockResolvedValue({});

    await expect(service.create({ name: 'Falha' })).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );

    expect(storageMock.removeWorkspaceStorage).not.toHaveBeenCalled();
    expect(databaseMock.removeWorkspaceDatabase).toHaveBeenCalledTimes(1);
    expect(prismaMock.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          provisioningError: 'storage unavailable',
        }),
      }),
    );
  });

  it('não remove recursos que não chegou a criar', async () => {
    prismaMock.workspace.create.mockResolvedValue({});
    databaseMock.provisionWorkspaceDatabase.mockRejectedValue(
      new Error('database already exists'),
    );
    prismaMock.workspace.update.mockResolvedValue({});

    await expect(
      service.create({ name: 'Falha segura' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(storageMock.provisionWorkspaceStorage).not.toHaveBeenCalled();
    expect(storageMock.removeWorkspaceStorage).not.toHaveBeenCalled();
    expect(databaseMock.removeWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it('compensa banco e buckets quando a publicação READY falha', async () => {
    prismaMock.workspace.create.mockResolvedValue({});
    prismaMock.workspace.update
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce({});

    await expect(
      service.create({ name: 'Falha final' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(storageMock.removeWorkspaceStorage).toHaveBeenCalledTimes(1);
    expect(databaseMock.removeWorkspaceDatabase).toHaveBeenCalledTimes(1);
  });

  it('recusa uma cor inválida antes de criar recursos', async () => {
    await expect(
      service.create({ name: 'Marketing', color: 'orange' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prismaMock.workspace.create).not.toHaveBeenCalled();
    expect(databaseMock.provisionWorkspaceDatabase).not.toHaveBeenCalled();
  });
});
