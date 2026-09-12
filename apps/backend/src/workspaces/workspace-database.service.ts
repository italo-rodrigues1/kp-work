import 'dotenv/config';
import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool, PoolClient } from 'pg';
import { PrismaService } from '../prisma.service';
import {
  WORKSPACE_BOOTSTRAP_SQL,
  WORKSPACE_SCHEMA_VERSION,
} from './workspace-bootstrap.sql';
import { assertBucketName, assertDatabaseName } from './workspace-resources';

export type WorkspaceProvisioningStatus = 'PROVISIONING' | 'READY' | 'FAILED';

export interface WorkspaceInfrastructure {
  id: string;
  databaseName: string;
  uploadBucket: string;
  contextBucket: string;
  status: WorkspaceProvisioningStatus;
}

export interface WorkspaceBootstrapRecord extends WorkspaceInfrastructure {
  name: string;
  color: string;
}

interface TenantClientEntry {
  databaseName: string;
  client: PrismaClient;
  pool: Pool;
}

interface TenantClientCacheEntry {
  promise: Promise<TenantClientEntry>;
  lastUsedAt: number;
}

const DEFAULT_DATABASE_URL =
  'postgresql://postgres:postgrespassword@localhost:5433/chat_ai?schema=public';

@Injectable()
export class WorkspaceDatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceDatabaseService.name);
  private readonly clients = new Map<string, TenantClientCacheEntry>();
  private readonly catalogDatabaseUrl =
    process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

  constructor(private readonly catalog: PrismaService) {}

  async forWorkspace(workspaceId: string): Promise<PrismaClient> {
    const infrastructure = await this.getInfrastructure(workspaceId);
    const cached = this.clients.get(workspaceId);
    if (cached) {
      const entry = await cached.promise;
      if (entry.databaseName === infrastructure.databaseName) {
        this.touch(workspaceId, cached);
        await this.evictOverflow(workspaceId);
        return entry.client;
      }
      await this.disconnectEntry(workspaceId, entry);
    }

    const pending = this.createTenantClient(infrastructure.databaseName);
    const cacheEntry = { promise: pending, lastUsedAt: Date.now() };
    this.clients.set(workspaceId, cacheEntry);

    try {
      const entry = await pending;
      this.touch(workspaceId, cacheEntry);
      await this.evictOverflow(workspaceId);
      return entry.client;
    } catch (error) {
      if (this.clients.get(workspaceId) === cacheEntry) {
        this.clients.delete(workspaceId);
      }
      throw error;
    }
  }

  async getInfrastructure(
    workspaceId: string,
  ): Promise<WorkspaceInfrastructure> {
    const workspace = await this.catalog.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        databaseName: true,
        uploadBucket: true,
        contextBucket: true,
        status: true,
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace não encontrado.');
    }
    if (workspace.status !== 'READY') {
      throw new ServiceUnavailableException(
        workspace.status === 'FAILED'
          ? 'O provisionamento deste workspace falhou.'
          : 'Este workspace ainda está sendo provisionado.',
      );
    }

    return {
      ...workspace,
      status: 'READY',
    };
  }

  async provisionWorkspaceDatabase(
    workspace: WorkspaceBootstrapRecord,
  ): Promise<void> {
    assertDatabaseName(workspace.databaseName);
    assertBucketName(workspace.uploadBucket);
    assertBucketName(workspace.contextBucket);
    await this.createDatabase(workspace.databaseName);

    try {
      await this.bootstrapDatabase(workspace);
    } catch (error) {
      await this.removeWorkspaceDatabase(workspace.databaseName).catch(
        (cleanupError) =>
          this.logger.error(
            `Falha ao remover banco incompleto ${workspace.databaseName}: ${this.errorMessage(cleanupError)}`,
          ),
      );
      throw error;
    }
  }

  async removeWorkspaceDatabase(databaseName: string): Promise<void> {
    const catalogDatabaseName = this.databaseNameFromUrl(
      this.catalogDatabaseUrl,
    );
    if (databaseName === catalogDatabaseName) {
      throw new Error('Refusing to remove the catalog database.');
    }
    assertDatabaseName(databaseName);

    for (const [workspaceId, cached] of this.clients) {
      const entry = await cached.promise.catch(() => undefined);
      if (entry?.databaseName === databaseName) {
        await this.disconnectEntry(workspaceId, entry);
      }
    }

    const adminPool = this.createAdminPool();
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await adminPool.end();
    }
  }

  async onModuleDestroy(): Promise<void> {
    const entries = await Promise.allSettled(
      [...this.clients.values()].map(({ promise }) => promise),
    );
    this.clients.clear();

    await Promise.allSettled(
      entries.flatMap((result) =>
        result.status === 'fulfilled'
          ? [result.value.client.$disconnect()]
          : [],
      ),
    );
  }

  private async createDatabase(databaseName: string): Promise<void> {
    assertDatabaseName(databaseName);
    const adminPool = this.createAdminPool();
    try {
      const existing = await adminPool.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS "exists"',
        [databaseName],
      );
      if (existing.rows[0]?.exists) {
        throw new Error(`Workspace database already exists: ${databaseName}`);
      }
      await adminPool.query(
        `CREATE DATABASE ${this.quoteIdentifier(databaseName)} OWNER ${this.quoteIdentifier(this.catalogRoleName())}`,
      );
    } finally {
      await adminPool.end();
    }
  }

  private async bootstrapDatabase(
    workspace: WorkspaceBootstrapRecord,
  ): Promise<void> {
    const pool = new Pool({
      connectionString: this.databaseUrlFor(workspace.databaseName),
      max: 1,
    });
    let connection: PoolClient | undefined;

    try {
      connection = await pool.connect();
      await connection.query('BEGIN');
      await connection.query(WORKSPACE_BOOTSTRAP_SQL);
      await connection.query(
        `INSERT INTO "Workspace" (
          "id", "name", "color", "databaseName", "uploadBucket",
          "contextBucket", "status", "createdAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, 'READY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          workspace.id,
          workspace.name,
          workspace.color,
          workspace.databaseName,
          workspace.uploadBucket,
          workspace.contextBucket,
        ],
      );
      await connection.query(
        'INSERT INTO "WorkspaceSchemaVersion" ("version") VALUES ($1)',
        [WORKSPACE_SCHEMA_VERSION],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection?.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection?.release();
      await pool.end();
    }
  }

  private createAdminPool(): Pool {
    return new Pool({
      connectionString:
        process.env.WORKSPACE_DATABASE_ADMIN_URL || this.adminDatabaseUrl(),
      max: 1,
    });
  }

  private async createTenantClient(
    databaseName: string,
  ): Promise<TenantClientEntry> {
    const pool = new Pool({
      connectionString: this.databaseUrlFor(databaseName),
      max: this.tenantPoolSize(),
    });
    const adapter = new PrismaPg(pool, { disposeExternalPool: true });
    const client = new PrismaClient({ adapter });

    try {
      await client.$connect();
      if (databaseName !== this.databaseNameFromUrl(this.catalogDatabaseUrl)) {
        const version = await pool.query<{ version: number | string | null }>(
          'SELECT MAX("version") AS "version" FROM "WorkspaceSchemaVersion"',
        );
        const currentVersion = Number(version.rows[0]?.version);
        if (currentVersion !== WORKSPACE_SCHEMA_VERSION) {
          throw new ServiceUnavailableException(
            `Workspace database schema ${currentVersion || 'desconhecido'}; esperado ${WORKSPACE_SCHEMA_VERSION}.`,
          );
        }
      }
      return { databaseName, client, pool };
    } catch (error) {
      await client.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  private async disconnectEntry(
    workspaceId: string,
    entry: TenantClientEntry,
  ): Promise<void> {
    this.clients.delete(workspaceId);
    try {
      await entry.client.$disconnect();
    } catch (error) {
      this.logger.warn(
        `Falha ao encerrar o pool do workspace ${workspaceId}: ${this.errorMessage(error)}`,
      );
    }
  }

  private touch(workspaceId: string, cached: TenantClientCacheEntry): void {
    if (this.clients.get(workspaceId) !== cached) return;
    cached.lastUsedAt = Date.now();
    this.clients.delete(workspaceId);
    this.clients.set(workspaceId, cached);
  }

  private async evictOverflow(protectedWorkspaceId: string): Promise<void> {
    const maximum = this.cacheMaximum();
    const idleTime = this.cacheIdleMilliseconds();
    while (this.clients.size > maximum) {
      const candidate = [...this.clients.entries()].find(
        ([workspaceId, cached]) =>
          workspaceId !== protectedWorkspaceId &&
          Date.now() - cached.lastUsedAt >= idleTime,
      );
      if (!candidate) return;

      const [workspaceId, cached] = candidate;
      const entry = await cached.promise.catch(() => undefined);
      if (
        this.clients.get(workspaceId) !== cached ||
        Date.now() - cached.lastUsedAt < idleTime
      ) {
        continue;
      }
      if (
        entry &&
        (entry.pool.waitingCount > 0 ||
          entry.pool.totalCount !== entry.pool.idleCount)
      ) {
        // A long-running operation can outlive the idle TTL. Keep its pool and
        // allow a temporary cache overflow until a later access retries cleanup.
        cached.lastUsedAt = Date.now();
        continue;
      }

      this.clients.delete(workspaceId);
      if (entry) {
        try {
          await entry.client.$disconnect();
        } catch (error) {
          this.logger.warn(
            `Falha ao remover workspace ${workspaceId} do cache: ${this.errorMessage(error)}`,
          );
        }
      }
    }
  }

  private databaseUrlFor(databaseName: string): string {
    const url = this.parseDatabaseUrl(this.catalogDatabaseUrl);
    url.pathname = `/${databaseName}`;
    return url.toString();
  }

  private adminDatabaseUrl(): string {
    const url = this.parseDatabaseUrl(this.catalogDatabaseUrl);
    url.pathname = '/postgres';
    url.searchParams.delete('schema');
    return url.toString();
  }

  private databaseNameFromUrl(connectionString: string): string {
    const name = decodeURIComponent(
      this.parseDatabaseUrl(connectionString).pathname.replace(/^\//, ''),
    );
    if (!name) {
      throw new Error('DATABASE_URL must include a database name.');
    }
    return name;
  }

  private catalogRoleName(): string {
    const username = decodeURIComponent(
      this.parseDatabaseUrl(this.catalogDatabaseUrl).username,
    );
    if (!username || username.includes('\0')) {
      throw new Error('DATABASE_URL must include a valid PostgreSQL role.');
    }
    return username;
  }

  private quoteIdentifier(value: string): string {
    if (!value || value.includes('\0')) {
      throw new Error('Invalid PostgreSQL identifier.');
    }
    return `"${value.replaceAll('"', '""')}"`;
  }

  private parseDatabaseUrl(connectionString: string): URL {
    try {
      const url = new URL(connectionString);
      if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
        throw new Error('unsupported protocol');
      }
      return url;
    } catch {
      throw new Error('A valid PostgreSQL DATABASE_URL is required.');
    }
  }

  private tenantPoolSize(): number {
    const configured = Number.parseInt(
      process.env.WORKSPACE_DATABASE_POOL_MAX || '5',
      10,
    );
    return Number.isInteger(configured) && configured > 0 ? configured : 5;
  }

  private cacheMaximum(): number {
    const configured = Number.parseInt(
      process.env.WORKSPACE_DATABASE_CACHE_MAX || '20',
      10,
    );
    return Number.isInteger(configured) && configured > 0 ? configured : 20;
  }

  private cacheIdleMilliseconds(): number {
    const configured = Number.parseInt(
      process.env.WORKSPACE_DATABASE_CACHE_IDLE_MS || '60000',
      10,
    );
    return Number.isInteger(configured) && configured >= 60_000
      ? configured
      : 60_000;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
