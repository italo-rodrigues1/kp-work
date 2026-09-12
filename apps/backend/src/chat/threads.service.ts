import { Injectable, NotFoundException } from '@nestjs/common';
import { WorkspaceDatabaseService } from '../workspaces/workspace-database.service';
import { CreateThreadDto, UpdateThreadDto } from './dto/thread.dto';

type BigIntsAsNumbers<T> = T extends bigint
  ? number
  : T extends Date
    ? Date
    : T extends Array<infer Item>
      ? Array<BigIntsAsNumbers<Item>>
      : T extends object
        ? { [Key in keyof T]: BigIntsAsNumbers<T[Key]> }
        : T;

function serializeBigInts<T>(value: T): BigIntsAsNumbers<T> {
  if (typeof value === 'bigint') {
    const serialized = Number(value);
    if (!Number.isSafeInteger(serialized)) {
      throw new RangeError('O tamanho do anexo excede o limite seguro da API.');
    }
    return serialized as BigIntsAsNumbers<T>;
  }

  if (value instanceof Date) {
    return value as BigIntsAsNumbers<T>;
  }

  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) =>
      serializeBigInts(item),
    ) as BigIntsAsNumbers<T>;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        serializeBigInts(item),
      ]),
    ) as BigIntsAsNumbers<T>;
  }

  return value as BigIntsAsNumbers<T>;
}

@Injectable()
export class ThreadsService {
  constructor(private readonly workspaceDatabases: WorkspaceDatabaseService) {}

  async findAll(workspaceId: string) {
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);

    const threads = await prisma.thread.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            attachments: true,
            audio: true,
          },
        },
      },
    });

    return serializeBigInts(threads);
  }

  async findOne(workspaceId: string, id: string) {
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    const thread = await prisma.thread.findFirst({
      where: { id, workspaceId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            attachments: true,
            audio: true,
          },
        },
      },
    });

    if (!thread) {
      throw new NotFoundException(`Thread com ID "${id}" não encontrada.`);
    }

    return serializeBigInts(thread);
  }

  async create(workspaceId: string, dto: CreateThreadDto) {
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);

    const thread = await prisma.thread.create({
      data: {
        title: dto.title || 'Nova Conversa',
        model: dto.model || 'openai/gpt-4o',
        workspaceId,
      },
      include: {
        messages: {
          include: {
            attachments: true,
            audio: true,
          },
        },
      },
    });

    return serializeBigInts(thread);
  }

  async update(workspaceId: string, id: string, dto: UpdateThreadDto) {
    await this.findOne(workspaceId, id);
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);

    const thread = await prisma.thread.update({
      where: { id },
      data: {
        ...(dto.title ? { title: dto.title } : {}),
        ...(dto.model ? { model: dto.model } : {}),
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            attachments: true,
            audio: true,
          },
        },
      },
    });

    return serializeBigInts(thread);
  }

  async remove(workspaceId: string, id: string) {
    const [prisma, infrastructure] = await Promise.all([
      this.workspaceDatabases.forWorkspace(workspaceId),
      this.workspaceDatabases.getInfrastructure(workspaceId),
    ]);

    return prisma.$transaction(
      async (tx) => {
        const thread = await tx.thread.findFirst({
          where: { id, workspaceId },
          select: {
            id: true,
            uploadSessions: {
              select: {
                objectKey: true,
                multipartUploadId: true,
              },
            },
          },
        });

        if (!thread) {
          throw new NotFoundException(`Thread com ID "${id}" não encontrada.`);
        }

        if (thread.uploadSessions.length) {
          await tx.storageDeletionTask.createMany({
            data: thread.uploadSessions.map((upload) => ({
              workspaceId,
              bucket: infrastructure.uploadBucket,
              objectKey: upload.objectKey,
              multipartUploadId: upload.multipartUploadId,
            })),
            skipDuplicates: true,
          });
        }

        return tx.thread.delete({ where: { id } });
      },
      { isolationLevel: 'Serializable' },
    );
  }
}
