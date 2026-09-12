import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { StorageService } from '../chat/storage.service';
import { PrismaService } from '../prisma.service';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from './dto/workspace.dto';
import {
  WorkspaceDatabaseService,
  WorkspaceInfrastructure,
} from './workspace-database.service';
import { newWorkspaceResourceNames } from './workspace-resources';

const DEFAULT_WORKSPACE_ID = 'workspace-default';
const DEFAULT_WORKSPACE_COLOR = '#f97316';
const DEFAULT_DATABASE_URL =
  'postgresql://postgres:postgrespassword@localhost:5433/chat_ai?schema=public';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export interface PublicWorkspace {
  id: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
  _count: { threads: number };
}

@Injectable()
export class WorkspacesService implements OnModuleInit {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceDatabases: WorkspaceDatabaseService,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureDefaultWorkspace();
  }

  async findAll(): Promise<PublicWorkspace[]> {
    await this.ensureDefaultWorkspace();

    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'READY' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        color: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return this.mapWithConcurrency(
      workspaces,
      this.listConcurrency(),
      async (workspace) => {
        const tenant = await this.workspaceDatabases.forWorkspace(workspace.id);
        const threadCount = await tenant.thread.count({
          where: { workspaceId: workspace.id },
        });
        return { ...workspace, _count: { threads: threadCount } };
      },
    );
  }

  async findOne(id: string): Promise<PublicWorkspace> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id, status: 'READY' },
      select: {
        id: true,
        name: true,
        color: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace com ID "${id}" não encontrado.`);
    }

    const tenant = await this.workspaceDatabases.forWorkspace(id);
    const threadCount = await tenant.thread.count({
      where: { workspaceId: id },
    });
    return { ...workspace, _count: { threads: threadCount } };
  }

  async create(dto: CreateWorkspaceDto): Promise<PublicWorkspace> {
    const name = this.normalizeName(dto.name);
    const color = this.normalizeColor(dto.color);
    const resources = newWorkspaceResourceNames();
    const infrastructure: WorkspaceInfrastructure = {
      ...resources,
      status: 'PROVISIONING',
    };

    await this.prisma.workspace.create({
      data: {
        ...resources,
        name,
        color,
        status: 'PROVISIONING',
      },
    });

    let databaseProvisioned = false;
    let storageProvisioned = false;
    try {
      await this.workspaceDatabases.provisionWorkspaceDatabase({
        ...infrastructure,
        name,
        color,
      });
      console.log(`Workspace database provisioned: ${resources.databaseName}`);
      databaseProvisioned = true;
      // await this.storage.provisionWorkspaceStorage(resources);
      storageProvisioned = true;

      const ready = await this.prisma.workspace.update({
        where: { id: resources.id },
        data: { status: 'READY', provisioningError: null },
        select: {
          id: true,
          name: true,
          color: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return { ...ready, _count: { threads: 0 } };
    } catch (error) {
      await this.compensateFailedProvisioning(
        infrastructure,
        databaseProvisioned,
        storageProvisioned,
      );
      await this.prisma.workspace
        .update({
          where: { id: resources.id },
          data: {
            status: 'FAILED',
            provisioningError: this.errorMessage(error).slice(0, 2000),
          },
        })
        .catch((catalogError) =>
          this.logger.error(
            `Falha ao marcar workspace ${resources.id} como FAILED: ${this.errorMessage(catalogError)}`,
          ),
        );

      this.logger.error(
        `Provisionamento do workspace ${resources.id} falhou: ${this.errorMessage(error)}`,
      );
      throw new InternalServerErrorException(
        'Não foi possível provisionar o workspace.',
      );
    }
  }

  async update(id: string, dto: UpdateWorkspaceDto): Promise<PublicWorkspace> {
    if (dto.name === undefined && dto.color === undefined) {
      throw new BadRequestException(
        'Informe ao menos um campo para atualizar.',
      );
    }

    const current = await this.findOne(id);
    const data = {
      ...(dto.name !== undefined ? { name: this.normalizeName(dto.name) } : {}),
      ...(dto.color !== undefined
        ? { color: this.normalizeColor(dto.color) }
        : {}),
    };
    const tenant = await this.workspaceDatabases.forWorkspace(id);

    await tenant.workspace.update({ where: { id }, data });
    try {
      const updated = await this.prisma.workspace.update({
        where: { id },
        data,
        select: {
          id: true,
          name: true,
          color: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return { ...updated, _count: current._count };
    } catch (error) {
      await tenant.workspace
        .update({
          where: { id },
          data: { name: current.name, color: current.color },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private async ensureDefaultWorkspace(): Promise<void> {
    const infrastructure = {
      databaseName: this.catalogDatabaseName(),
      uploadBucket: process.env.MINIO_CHAT_UPLOAD_BUCKET || 'chat-uploads',
      contextBucket: process.env.MINIO_AGENT_CONTEXT_BUCKET || 'agent-contexts',
      status: 'READY',
      provisioningError: null,
    } as const;
    const existing = await this.prisma.workspace.findUnique({
      where: { id: DEFAULT_WORKSPACE_ID },
      select: {
        id: true,
        databaseName: true,
        uploadBucket: true,
        contextBucket: true,
        status: true,
        provisioningError: true,
      },
    });
    if (existing) {
      if (
        existing.databaseName !== infrastructure.databaseName ||
        existing.uploadBucket !== infrastructure.uploadBucket ||
        existing.contextBucket !== infrastructure.contextBucket ||
        existing.status !== infrastructure.status ||
        existing.provisioningError !== null
      ) {
        await this.prisma.workspace.update({
          where: { id: DEFAULT_WORKSPACE_ID },
          data: infrastructure,
        });
      }
      return;
    }

    await this.prisma.workspace.create({
      data: {
        id: DEFAULT_WORKSPACE_ID,
        name: 'Pessoal',
        color: DEFAULT_WORKSPACE_COLOR,
        ...infrastructure,
      },
    });
  }

  private async compensateFailedProvisioning(
    workspace: WorkspaceInfrastructure,
    databaseProvisioned: boolean,
    storageProvisioned: boolean,
  ): Promise<void> {
    const compensation: Promise<void>[] = [];
    if (storageProvisioned) {
      compensation.push(this.storage.removeWorkspaceStorage(workspace));
    }
    if (databaseProvisioned) {
      compensation.push(
        this.workspaceDatabases.removeWorkspaceDatabase(workspace.databaseName),
      );
    }
    const results = await Promise.allSettled(compensation);

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Compensação de workspace incompleta: ${this.errorMessage(result.reason)}`,
        );
      }
    }
  }

  private catalogDatabaseName(): string {
    const value = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
    try {
      const name = decodeURIComponent(
        new URL(value).pathname.replace(/^\//, ''),
      );
      if (name) return name;
    } catch {
      // PrismaService reports the invalid DATABASE_URL during startup.
    }
    throw new Error('DATABASE_URL must include a database name.');
  }

  private normalizeName(value?: string): string {
    const name = value?.trim();
    if (!name) {
      throw new BadRequestException('O nome do workspace é obrigatório.');
    }
    if (name.length > 60) {
      throw new BadRequestException(
        'O nome do workspace deve ter no máximo 60 caracteres.',
      );
    }
    return name;
  }

  private normalizeColor(value?: string): string {
    const color = value?.trim() || DEFAULT_WORKSPACE_COLOR;
    if (!HEX_COLOR.test(color)) {
      throw new BadRequestException(
        'A cor do workspace deve estar no formato hexadecimal.',
      );
    }
    return color.toLowerCase();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private listConcurrency(): number {
    const configured = Number.parseInt(
      process.env.WORKSPACE_DATABASE_LIST_CONCURRENCY || '5',
      10,
    );
    return Number.isInteger(configured) && configured > 0 ? configured : 5;
  }

  private async mapWithConcurrency<Input, Output>(
    values: Input[],
    concurrency: number,
    mapper: (value: Input) => Promise<Output>,
  ): Promise<Output[]> {
    const output = new Array<Output>(values.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        while (nextIndex < values.length) {
          const index = nextIndex;
          nextIndex += 1;
          output[index] = await mapper(values[index]);
        }
      },
    );
    await Promise.all(workers);
    return output;
  }
}
