/* eslint-disable @typescript-eslint/no-unsafe-return */
import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  WorkspaceBootstrapRecord,
  WorkspaceDatabaseService,
} from './workspace-database.service';
import {
  WORKSPACE_BOOTSTRAP_SQL,
  WORKSPACE_SCHEMA_VERSION,
} from './workspace-bootstrap.sql';

const mockPoolFactory = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn((options: unknown) => mockPoolFactory(options)),
}));

jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn(),
}));

describe('WorkspaceDatabaseService', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalCacheMax = process.env.WORKSPACE_DATABASE_CACHE_MAX;
  const originalCacheIdle = process.env.WORKSPACE_DATABASE_CACHE_IDLE_MS;
  const catalogMock = {
    workspace: { findUnique: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATABASE_URL =
      'postgresql://catalog:secret@localhost:5432/chat_ai?schema=public';
    delete process.env.WORKSPACE_DATABASE_CACHE_MAX;
    delete process.env.WORKSPACE_DATABASE_CACHE_IDLE_MS;
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalCacheMax === undefined) {
      delete process.env.WORKSPACE_DATABASE_CACHE_MAX;
    } else {
      process.env.WORKSPACE_DATABASE_CACHE_MAX = originalCacheMax;
    }
    if (originalCacheIdle === undefined) {
      delete process.env.WORKSPACE_DATABASE_CACHE_IDLE_MS;
    } else {
      process.env.WORKSPACE_DATABASE_CACHE_IDLE_MS = originalCacheIdle;
    }
  });

  it('recusa resolver um workspace que ainda não está READY', async () => {
    catalogMock.workspace.findUnique.mockResolvedValue({
      id: 'workspace-id',
      databaseName: 'chat_ai_ws_deadbeef',
      uploadBucket: 'workspace-deadbeef-uploads',
      contextBucket: 'workspace-deadbeef-contexts',
      status: 'PROVISIONING',
    });
    const service = new WorkspaceDatabaseService(
      catalogMock as unknown as PrismaService,
    );

    await expect(service.forWorkspace('workspace-id')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockPoolFactory).not.toHaveBeenCalled();
  });

  it('cria o banco e aplica o bootstrap versionado em transação', async () => {
    const adminPool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        .mockResolvedValueOnce({ rows: [] }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    const connection = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    const tenantPool = {
      connect: jest.fn().mockResolvedValue(connection),
      end: jest.fn().mockResolvedValue(undefined),
    };
    mockPoolFactory
      .mockReturnValueOnce(adminPool)
      .mockReturnValueOnce(tenantPool);
    const service = new WorkspaceDatabaseService(
      catalogMock as unknown as PrismaService,
    );
    const workspace: WorkspaceBootstrapRecord = {
      id: '123e4567-e89b-42d3-a456-426614174000',
      name: 'Marketing',
      color: '#8b5cf6',
      databaseName: 'chat_ai_ws_123e4567e89b42d3a456426614174000',
      uploadBucket: 'chat-ai-ws-123e4567e89b42d3a456426614174000-uploads',
      contextBucket: 'chat-ai-ws-123e4567e89b42d3a456426614174000-contexts',
      status: 'PROVISIONING',
    };

    await service.provisionWorkspaceDatabase(workspace);

    expect(adminPool.query).toHaveBeenNthCalledWith(
      2,
      `CREATE DATABASE "${workspace.databaseName}" OWNER "catalog"`,
    );
    expect(connection.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      WORKSPACE_BOOTSTRAP_SQL,
    );
    expect(connection.query).toHaveBeenCalledWith(
      'INSERT INTO "WorkspaceSchemaVersion" ("version") VALUES ($1)',
      [WORKSPACE_SCHEMA_VERSION],
    );
    expect(connection.query).toHaveBeenLastCalledWith('COMMIT');
    expect(connection.release).toHaveBeenCalled();
    expect(tenantPool.end).toHaveBeenCalled();
  });

  it('não remove um banco preexistente que não foi criado pelo serviço', async () => {
    const adminPool = {
      query: jest.fn().mockResolvedValue({ rows: [{ exists: true }] }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    mockPoolFactory.mockReturnValueOnce(adminPool);
    const service = new WorkspaceDatabaseService(
      catalogMock as unknown as PrismaService,
    );

    await expect(
      service.provisionWorkspaceDatabase({
        id: '123e4567-e89b-42d3-a456-426614174000',
        name: 'Existente',
        color: '#f97316',
        databaseName: 'chat_ai_ws_123e4567e89b42d3a456426614174000',
        uploadBucket: 'chat-ai-ws-123e4567e89b42d3a456426614174000-uploads',
        contextBucket: 'chat-ai-ws-123e4567e89b42d3a456426614174000-contexts',
        status: 'PROVISIONING',
      }),
    ).rejects.toThrow('already exists');

    expect(mockPoolFactory).toHaveBeenCalledTimes(1);
    expect(adminPool.query).toHaveBeenCalledTimes(1);
  });

  it('nunca remove o banco de catálogo', async () => {
    const service = new WorkspaceDatabaseService(
      catalogMock as unknown as PrismaService,
    );

    await expect(service.removeWorkspaceDatabase('chat_ai')).rejects.toThrow(
      'Refusing to remove the catalog database.',
    );
    expect(mockPoolFactory).not.toHaveBeenCalled();
  });

  it('permite overflow temporário e só remove um client ocioso', async () => {
    process.env.WORKSPACE_DATABASE_CACHE_MAX = '1';
    process.env.WORKSPACE_DATABASE_CACHE_IDLE_MS = '60000';
    catalogMock.workspace.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => ({
        id: where.id,
        databaseName: `chat_ai_ws_${where.id}`,
        uploadBucket: `workspace-${where.id}-uploads`,
        contextBucket: `workspace-${where.id}-contexts`,
        status: 'READY',
      }),
    );
    const firstDisconnect = jest.fn().mockResolvedValue(undefined);
    const secondDisconnect = jest.fn().mockResolvedValue(undefined);
    const service = new WorkspaceDatabaseService(
      catalogMock as unknown as PrismaService,
    );
    const internals = service as unknown as {
      clients: Map<
        string,
        {
          promise: Promise<{
            databaseName: string;
            client: { $disconnect: jest.Mock };
            pool: {
              totalCount: number;
              idleCount: number;
              waitingCount: number;
            };
          }>;
          lastUsedAt: number;
        }
      >;
      createTenantClient: jest.Mock;
      evictOverflow: (workspaceId: string) => Promise<void>;
    };
    internals.createTenantClient = jest
      .fn()
      .mockResolvedValueOnce({
        databaseName: 'chat_ai_ws_first',
        client: { $disconnect: firstDisconnect },
        pool: { totalCount: 1, idleCount: 1, waitingCount: 0 },
      })
      .mockResolvedValueOnce({
        databaseName: 'chat_ai_ws_second',
        client: { $disconnect: secondDisconnect },
        pool: { totalCount: 1, idleCount: 1, waitingCount: 0 },
      });

    await service.forWorkspace('first');
    await service.forWorkspace('second');

    expect(internals.clients.size).toBe(2);
    expect(firstDisconnect).not.toHaveBeenCalled();

    const first = internals.clients.get('first');
    if (!first) throw new Error('first cache entry was not retained');
    first.lastUsedAt = Date.now() - 60_001;
    await internals.evictOverflow('second');

    expect(firstDisconnect).toHaveBeenCalledTimes(1);
    expect(secondDisconnect).not.toHaveBeenCalled();
    expect(internals.clients.has('first')).toBe(false);
  });
});
