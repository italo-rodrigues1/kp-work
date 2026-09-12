import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { WorkspaceDatabaseService } from '../workspaces/workspace-database.service';
import { StorageService, UploadedPart } from './storage.service';

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;
const TASK_LEASE_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STALE_STATE_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;

interface ExpiredUploadSession {
  id: string;
  objectKey: string;
  size: bigint;
  type: string;
  mode: 'SINGLE' | 'MULTIPART';
  multipartUploadId: string | null;
  partSize: bigint | null;
  partCount: number | null;
  status: 'PENDING' | 'COMPLETING' | 'COMPLETED' | 'DELETING';
  expiresAt: Date;
  updatedAt: Date;
}

interface StorageDeletionTaskRecord {
  id: string;
  bucket: string;
  objectKey: string;
  multipartUploadId: string | null;
  status: 'PENDING' | 'PROCESSING';
  attempts: number;
  nextAttemptAt: Date;
}

@Injectable()
export class UploadCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadCleanupService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly catalog: PrismaService,
    private readonly workspaceDatabases: WorkspaceDatabaseService,
    private readonly storageService: StorageService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.readPositiveInteger(
      process.env.UPLOAD_CLEANUP_INTERVAL_MS,
      CLEANUP_INTERVAL_MS,
    );
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.logger.error(`Upload cleanup failed: ${this.errorMessage(error)}`);
      });
    }, intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const workspaces = await this.catalog.workspace.findMany({
        where: { status: 'READY' },
        select: { id: true, uploadBucket: true },
        orderBy: { createdAt: 'asc' },
      });
      let remaining = Math.min(
        this.readPositiveInteger(
          process.env.UPLOAD_CLEANUP_BATCH_SIZE,
          CLEANUP_BATCH_SIZE,
        ),
        CLEANUP_BATCH_SIZE,
      );

      for (const workspace of workspaces) {
        if (remaining <= 0) {
          break;
        }
        try {
          const prisma = await this.workspaceDatabases.forWorkspace(
            workspace.id,
          );
          remaining = await this.cleanupWorkspace(
            prisma,
            workspace.id,
            workspace.uploadBucket,
            remaining,
          );
        } catch (error) {
          this.logger.warn(
            `Upload cleanup skipped workspace ${workspace.id}: ${this.errorMessage(error)}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async cleanupWorkspace(
    prisma: Awaited<ReturnType<WorkspaceDatabaseService['forWorkspace']>>,
    workspaceId: string,
    uploadBucket: string,
    remaining: number,
  ): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() -
        this.readPositiveInteger(
          process.env.UPLOAD_CLEANUP_STALE_STATE_MS,
          DEFAULT_STALE_STATE_MS,
        ),
    );
    const sessions = (await prisma.uploadSession.findMany({
      where: {
        thread: { workspaceId },
        messageId: null,
        OR: [
          {
            expiresAt: { lte: now },
            status: {
              in: ['PENDING', 'COMPLETING', 'COMPLETED', 'DELETING'],
            },
          },
          {
            status: { in: ['COMPLETING', 'DELETING'] },
            updatedAt: { lte: staleBefore },
          },
        ],
      },
      select: {
        id: true,
        objectKey: true,
        size: true,
        type: true,
        mode: true,
        multipartUploadId: true,
        partSize: true,
        partCount: true,
        status: true,
        expiresAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: remaining,
    })) as ExpiredUploadSession[];

    for (const session of sessions) {
      if (
        session.status === 'COMPLETING' &&
        session.expiresAt.getTime() > now.getTime()
      ) {
        await this.reconcileCompletingSession(
          prisma,
          uploadBucket,
          session,
          now,
          staleBefore,
        );
      } else {
        await this.cleanupExpiredSession(prisma, uploadBucket, session, now);
      }
    }
    remaining -= sessions.length;
    if (remaining <= 0) {
      return 0;
    }

    const tasks = (await prisma.storageDeletionTask.findMany({
      where: {
        workspaceId,
        bucket: uploadBucket,
        status: { in: ['PENDING', 'PROCESSING'] },
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: remaining,
    })) as StorageDeletionTaskRecord[];
    for (const task of tasks) {
      await this.processDeletionTask(
        prisma,
        workspaceId,
        uploadBucket,
        task,
        now,
      );
    }
    return remaining - tasks.length;
  }

  private async reconcileCompletingSession(
    prisma: Awaited<ReturnType<WorkspaceDatabaseService['forWorkspace']>>,
    bucketName: string,
    session: ExpiredUploadSession,
    now: Date,
    staleBefore: Date,
  ): Promise<void> {
    const claimed = await prisma.uploadSession.updateMany({
      where: {
        id: session.id,
        status: 'COMPLETING',
        messageId: null,
        expiresAt: { gt: now },
        updatedAt: { lte: staleBefore },
      },
      data: { updatedAt: now },
    });
    if (claimed.count === 0) {
      return;
    }

    const stored = await this.readStoredObject(bucketName, session);
    if (stored === 'valid') {
      await this.markRecoveredSessionCompleted(prisma, session, now);
      return;
    }
    if (stored === 'invalid' || stored === 'unavailable') {
      return;
    }

    if (
      session.mode !== 'MULTIPART' ||
      !session.multipartUploadId ||
      session.partSize === null ||
      !session.partCount
    ) {
      await this.resetAbandonedCompletion(prisma, session, now);
      return;
    }

    let parts: UploadedPart[];
    try {
      parts = await this.storageService.listMultipartParts(
        bucketName,
        session.objectKey,
        session.multipartUploadId,
      );
    } catch (error) {
      if (!this.storageService.isNotFoundError(error)) {
        this.logger.warn(
          `Could not inspect multipart upload ${session.id}: ${this.errorMessage(error)}`,
        );
      }
      return;
    }

    if (!this.multipartPartsAreComplete(session, parts)) {
      await this.resetAbandonedCompletion(prisma, session, now);
      return;
    }

    try {
      await this.storageService.completeMultipartUpload(
        bucketName,
        session.objectKey,
        session.multipartUploadId,
        parts,
      );
      const completedObject = await this.readStoredObject(bucketName, session);
      if (completedObject === 'valid') {
        await this.markRecoveredSessionCompleted(prisma, session, now);
      }
    } catch (error) {
      this.logger.warn(
        `Could not resume multipart completion ${session.id}: ${this.errorMessage(error)}`,
      );
    }
  }

  private async readStoredObject(
    bucketName: string,
    session: ExpiredUploadSession,
  ): Promise<'valid' | 'missing' | 'invalid' | 'unavailable'> {
    try {
      const metadata = await this.storageService.getUploadedObjectMetadata(
        bucketName,
        session.objectKey,
      );
      return metadata.size === Number(session.size) &&
        (!metadata.contentType || metadata.contentType === session.type)
        ? 'valid'
        : 'invalid';
    } catch (error) {
      if (this.storageService.isNotFoundError(error)) {
        return 'missing';
      }
      this.logger.warn(
        `Could not inspect completing upload ${session.id}: ${this.errorMessage(error)}`,
      );
      return 'unavailable';
    }
  }

  private multipartPartsAreComplete(
    session: ExpiredUploadSession,
    parts: UploadedPart[],
  ): boolean {
    if (session.partSize === null || !session.partCount) {
      return false;
    }
    const partSize = Number(session.partSize);
    const totalSize = Number(session.size);
    if (parts.length !== session.partCount) {
      return false;
    }
    return parts.every((part, index) => {
      const partNumber = index + 1;
      const expectedSize =
        partNumber < session.partCount!
          ? partSize
          : totalSize - partSize * (session.partCount! - 1);
      return part.partNumber === partNumber && part.size === expectedSize;
    });
  }

  private async markRecoveredSessionCompleted(
    prisma: Awaited<ReturnType<WorkspaceDatabaseService['forWorkspace']>>,
    session: ExpiredUploadSession,
    now: Date,
  ): Promise<void> {
    const sessionTtlSeconds = Math.min(
      this.readPositiveInteger(
        process.env.UPLOAD_SESSION_TTL_SECONDS,
        DEFAULT_SESSION_TTL_SECONDS,
      ),
      DEFAULT_SESSION_TTL_SECONDS,
    );
    await prisma.uploadSession.updateMany({
      where: {
        id: session.id,
        status: 'COMPLETING',
        messageId: null,
        expiresAt: { gt: now },
        updatedAt: now,
      },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        expiresAt: new Date(now.getTime() + sessionTtlSeconds * 1000),
      },
    });
  }

  private async resetAbandonedCompletion(
    prisma: Awaited<ReturnType<WorkspaceDatabaseService['forWorkspace']>>,
    session: ExpiredUploadSession,
    now: Date,
  ): Promise<void> {
    await prisma.uploadSession.updateMany({
      where: {
        id: session.id,
        status: 'COMPLETING',
        messageId: null,
        expiresAt: { gt: now },
        updatedAt: now,
      },
      data: { status: 'PENDING' },
    });
  }

  private async cleanupExpiredSession(
    prisma: Awaited<ReturnType<WorkspaceDatabaseService['forWorkspace']>>,
    bucketName: string,
    session: ExpiredUploadSession,
    now: Date,
  ): Promise<void> {
    if (session.status !== 'DELETING') {
      const claimed = await prisma.uploadSession.updateMany({
        where: {
          id: session.id,
          status: session.status,
          messageId: null,
          expiresAt: { lte: now },
        },
        data: { status: 'DELETING' },
      });
      if (claimed.count === 0) {
        return;
      }
    }

    try {
      if (session.multipartUploadId) {
        await this.storageService.abortMultipartUpload(
          bucketName,
          session.objectKey,
          session.multipartUploadId,
        );
      }
      await this.storageService.deleteUploadedObject(
        bucketName,
        session.objectKey,
      );
      await prisma.uploadSession.deleteMany({
        where: {
          id: session.id,
          status: 'DELETING',
          messageId: null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not remove expired upload ${session.id}: ${this.errorMessage(error)}`,
      );
    }
  }

  private async processDeletionTask(
    prisma: Awaited<ReturnType<WorkspaceDatabaseService['forWorkspace']>>,
    workspaceId: string,
    uploadBucket: string,
    task: StorageDeletionTaskRecord,
    now: Date,
  ): Promise<void> {
    const leaseUntil = new Date(now.getTime() + TASK_LEASE_MS);
    const claimed = await prisma.storageDeletionTask.updateMany({
      where: {
        id: task.id,
        workspaceId,
        bucket: uploadBucket,
        status: task.status,
        nextAttemptAt: { lte: now },
      },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        nextAttemptAt: leaseUntil,
        lastError: null,
      },
    });
    if (claimed.count === 0) {
      return;
    }

    try {
      if (task.multipartUploadId) {
        await this.storageService.abortMultipartUpload(
          uploadBucket,
          task.objectKey,
          task.multipartUploadId,
        );
      }
      await this.storageService.deleteUploadedObject(
        uploadBucket,
        task.objectKey,
      );
      await prisma.storageDeletionTask.updateMany({
        where: {
          id: task.id,
          status: 'PROCESSING',
          nextAttemptAt: leaseUntil,
        },
        data: {
          status: 'COMPLETED',
          nextAttemptAt: new Date(),
          lastError: null,
        },
      });
    } catch (error) {
      const delayMs = Math.min(
        MAX_RETRY_DELAY_MS,
        60_000 * 2 ** Math.min(task.attempts, 8),
      );
      await prisma.storageDeletionTask.updateMany({
        where: {
          id: task.id,
          status: 'PROCESSING',
          nextAttemptAt: leaseUntil,
        },
        data: {
          status: 'PENDING',
          nextAttemptAt: new Date(Date.now() + delayMs),
          lastError: this.errorMessage(error).slice(0, 1000),
        },
      });
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private readPositiveInteger(
    value: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
