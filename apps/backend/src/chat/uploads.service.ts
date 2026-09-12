import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WorkspaceDatabaseService } from '../workspaces/workspace-database.service';
import { StorageService, UploadedPart } from './storage.service';
import {
  CreateUploadSessionDto,
  UploadCategoryValue,
  UploadErrorCode,
  UploadModeValue,
  UploadPartsResponse,
  UploadSessionResponse,
  UploadStatusValue,
} from './dto/upload.dto';

const PENDING_STATUS = 'PENDING' as const;
const COMPLETING_STATUS = 'COMPLETING' as const;
const COMPLETED_STATUS = 'COMPLETED' as const;
const ATTACHED_STATUS = 'ATTACHED' as const;
const DELETING_STATUS = 'DELETING' as const;
const SINGLE_MODE = 'SINGLE' as const;
const MULTIPART_MODE = 'MULTIPART' as const;
const DOCUMENT_CATEGORY = 'DOCUMENT' as const;
const MEDIA_CATEGORY = 'MEDIA' as const;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_SINGLE_MAX_SIZE = 100 * MIB;
const DEFAULT_MEDIA_MAX_SIZE = 10 * GIB;
const DEFAULT_MULTIPART_PART_SIZE = 64 * MIB;
const DEFAULT_UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const MAX_ACTIVE_SESSIONS_PER_THREAD = 10;
const MAX_PART_URLS_PER_REQUEST = 3;

interface UploadSessionRecord {
  id: string;
  threadId: string;
  objectKey: string;
  name: string;
  size: bigint | number;
  type: string;
  mode: UploadModeValue;
  category: UploadCategoryValue;
  status: UploadStatusValue;
  multipartUploadId: string | null;
  partSize: bigint | number | null;
  partCount: number | null;
  expiresAt: Date;
  completedAt: Date | null;
  messageId: string | null;
  updatedAt?: Date;
}

@Injectable()
export class UploadsService {
  constructor(
    private readonly workspaceDatabases: WorkspaceDatabaseService,
    private readonly storageService: StorageService,
  ) {}

  async createSession(
    dto: CreateUploadSessionDto,
  ): Promise<UploadSessionResponse> {
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw this.badRequest(
        UploadErrorCode.InvalidRequest,
        'Os dados da sessão de upload são inválidos.',
      );
    }
    const workspaceId =
      typeof dto.workspaceId === 'string' ? dto.workspaceId.trim() : '';
    const threadId =
      typeof dto.threadId === 'string' ? dto.threadId.trim() : '';
    const rawFileName = dto.fileName ?? dto.name;
    const fileName = typeof rawFileName === 'string' ? rawFileName.trim() : '';
    const size = dto.size;
    if (
      dto.contentType !== undefined &&
      dto.contentType !== null &&
      typeof dto.contentType !== 'string'
    ) {
      throw this.badRequest(
        UploadErrorCode.InvalidRequest,
        'O tipo do arquivo é inválido.',
      );
    }
    const contentType =
      typeof dto.contentType === 'string' && dto.contentType.trim()
        ? dto.contentType.trim().toLowerCase()
        : 'application/octet-stream';

    if (contentType.length > 255 || /[\r\n]/.test(contentType)) {
      throw this.badRequest(
        UploadErrorCode.InvalidRequest,
        'O tipo do arquivo é inválido.',
      );
    }

    if (!workspaceId) {
      throw this.badRequest(
        UploadErrorCode.InvalidRequest,
        'O workspace do upload é obrigatório.',
      );
    }
    if (!threadId) {
      throw this.badRequest(
        UploadErrorCode.InvalidRequest,
        'A conversa do upload é obrigatória.',
      );
    }
    if (!fileName || fileName.length > 255) {
      throw this.badRequest(
        UploadErrorCode.InvalidRequest,
        'O nome do arquivo é inválido.',
      );
    }
    if (!Number.isSafeInteger(size) || !size || size <= 0) {
      throw this.badRequest(
        UploadErrorCode.EmptyFile,
        'O arquivo deve ter ao menos 1 byte.',
      );
    }

    const category = this.getCategory(contentType);
    const documentMaxSize = this.getDocumentMaxSize();
    const maxSize =
      category === MEDIA_CATEGORY
        ? this.getMediaMaxSize()
        : documentMaxSize;
    if (size > maxSize) {
      throw this.badRequest(
        UploadErrorCode.FileTooLarge,
        `O limite para este tipo de arquivo é ${maxSize} bytes.`,
      );
    }

    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    const infrastructure =
      await this.workspaceDatabases.getInfrastructure(workspaceId);
    const thread = await prisma.thread.findFirst({
      where: { id: threadId, workspaceId },
      select: { id: true },
    });
    if (!thread) {
      throw new NotFoundException({
        code: UploadErrorCode.NotFound,
        message: 'Conversa não encontrada.',
      });
    }

    const maxActiveSessions = this.getMaxAttachments();

    const mode: UploadModeValue =
      category === MEDIA_CATEGORY && size > this.getMultipartThreshold()
        ? MULTIPART_MODE
        : SINGLE_MODE;
    const partSize =
      mode === MULTIPART_MODE
        ? this.getMultipartPartSize()
        : null;
    const partCount = partSize ? Math.ceil(size / partSize) : null;
    const id = randomUUID();
    const safeFileName = this.sanitizeFileName(fileName);
    const objectKey = `uploads/${threadId}/${id}/${safeFileName}`;
    const expiresAt = this.nextSessionExpiration();

    let multipartUploadId: string | null = null;
    if (mode === MULTIPART_MODE) {
      multipartUploadId = await this.storageService.createMultipartUpload(
        infrastructure.uploadBucket,
        objectKey,
        contentType,
      );
    }

    let session: UploadSessionRecord;
    try {
      let serializationAttempts = 0;
      while (true) {
        try {
          session = await prisma.$transaction(
            async (tx) => {
              const activeSessionCount = await tx.uploadSession.count({
                where: {
                  threadId,
                  messageId: null,
                  expiresAt: { gt: new Date() },
                  status: {
                    in: [PENDING_STATUS, COMPLETING_STATUS, COMPLETED_STATUS],
                  },
                },
              });
              if (activeSessionCount >= maxActiveSessions) {
                throw this.sessionLimitException(maxActiveSessions);
              }
              return tx.uploadSession.create({
                data: {
                  id,
                  threadId,
                  objectKey,
                  name: fileName,
                  size: BigInt(size),
                  type: contentType,
                  mode,
                  category,
                  status: PENDING_STATUS,
                  multipartUploadId,
                  partSize: partSize === null ? null : BigInt(partSize),
                  partCount,
                  expiresAt,
                },
              });
            },
            { isolationLevel: 'Serializable' },
          );
          break;
        } catch (error) {
          if (
            this.isSerializationConflict(error) &&
            serializationAttempts < 2
          ) {
            serializationAttempts += 1;
            continue;
          }
          if (this.isSerializationConflict(error)) {
            throw this.sessionLimitException(maxActiveSessions);
          }
          throw error;
        }
      }
    } catch (error) {
      if (multipartUploadId) {
        await this.storageService
          .abortMultipartUpload(
            infrastructure.uploadBucket,
            objectKey,
            multipartUploadId,
          )
          .catch(() => undefined);
      }
      throw error;
    }

    if (mode === MULTIPART_MODE) {
      return this.toResponse(session);
    }

    const signed = await this.createSingleUploadUrl(
      infrastructure.uploadBucket,
      session,
    );
    return this.toResponse(session, signed);
  }

  async renewUploadUrl(
    workspaceId: string,
    id: string,
  ): Promise<UploadSessionResponse> {
    const session = await this.findSession(workspaceId, id);
    this.assertPendingAndActive(session, SINGLE_MODE);

    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    const expiresAt = this.nextSessionExpiration();
    const renewed = await prisma.uploadSession.updateMany({
      where: {
        id,
        status: PENDING_STATUS,
        mode: SINGLE_MODE,
        messageId: null,
        expiresAt: { gt: new Date() },
      },
      data: { expiresAt },
    });
    if (renewed.count === 0) {
      return this.resolveRenewalRace(workspaceId, id);
    }

    const infrastructure =
      await this.workspaceDatabases.getInfrastructure(workspaceId);
    const current = { ...session, expiresAt };
    const signed = await this.createSingleUploadUrl(
      infrastructure.uploadBucket,
      current,
    );
    return this.toResponse(current, signed);
  }

  async createPartUploadUrls(
    workspaceId: string,
    id: string,
    requestedPartNumbers: number[] | undefined,
  ): Promise<UploadPartsResponse> {
    const session = await this.findSession(workspaceId, id);
    this.assertPendingAndActive(session, MULTIPART_MODE);

    if (!Array.isArray(requestedPartNumbers)) {
      throw this.badRequest(
        UploadErrorCode.InvalidParts,
        'A lista de partes é inválida.',
      );
    }
    const partNumbers = requestedPartNumbers;
    const uniquePartNumbers = [...new Set(partNumbers)];
    if (
      partNumbers.length < 1 ||
      partNumbers.length > MAX_PART_URLS_PER_REQUEST ||
      uniquePartNumbers.length !== partNumbers.length ||
      uniquePartNumbers.some(
        (partNumber) =>
          !Number.isInteger(partNumber) ||
          partNumber < 1 ||
          !session.partCount ||
          partNumber > session.partCount,
      )
    ) {
      throw this.badRequest(
        UploadErrorCode.InvalidParts,
        `Informe entre 1 e ${MAX_PART_URLS_PER_REQUEST} partes válidas e sem repetição.`,
      );
    }
    if (!session.multipartUploadId || session.partSize === null) {
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'A sessão multipart não possui os dados necessários.',
      );
    }

    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    const expiresAt = this.nextSessionExpiration();
    const renewed = await prisma.uploadSession.updateMany({
      where: {
        id,
        status: PENDING_STATUS,
        mode: MULTIPART_MODE,
        messageId: null,
        expiresAt: { gt: new Date() },
      },
      data: { expiresAt },
    });
    if (renewed.count === 0) {
      const latest = await this.findSession(workspaceId, id);
      this.assertPendingAndActive(latest, MULTIPART_MODE);
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'A sessão mudou de estado durante a emissão das URLs.',
      );
    }

    const infrastructure =
      await this.workspaceDatabases.getInfrastructure(workspaceId);
    const ttlSeconds = this.getUploadUrlTtlSeconds();
    const uploadUrlExpiresAt = new Date(
      Date.now() + ttlSeconds * 1000,
    ).toISOString();
    const parts = await Promise.all(
      uniquePartNumbers.map(async (partNumber) => ({
        partNumber,
        uploadUrl: await this.storageService.createMultipartPartUploadUrl(
          infrastructure.uploadBucket,
          session.objectKey,
          session.multipartUploadId as string,
          session.type,
          partNumber,
          this.expectedPartSize(session, partNumber),
          ttlSeconds,
        ),
        uploadHeaders: { 'Content-Type': session.type },
        uploadUrlExpiresAt,
      })),
    );

    return { parts, expiresAt: expiresAt.toISOString() };
  }

  async completeSession(
    workspaceId: string,
    id: string,
  ): Promise<UploadSessionResponse> {
    const session = await this.findSession(workspaceId, id);

    if (session.status === ATTACHED_STATUS) {
      return this.completedResponse(workspaceId, session);
    }
    if (session.status === COMPLETED_STATUS) {
      this.assertNotExpired(session);
      return this.completedResponse(workspaceId, session);
    }
    if (session.status === COMPLETING_STATUS) {
      this.assertNotExpired(session);
      return this.reconcileCompletingSession(workspaceId, session);
    }
    if (session.status !== PENDING_STATUS) {
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'Esta sessão de upload não pode ser concluída.',
      );
    }
    this.assertNotExpired(session);

    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    const infrastructure =
      await this.workspaceDatabases.getInfrastructure(workspaceId);
    const claimed = await prisma.uploadSession.updateMany({
      where: {
        id,
        status: PENDING_STATUS,
        messageId: null,
        expiresAt: { gt: new Date() },
      },
      data: { status: COMPLETING_STATUS },
    });
    if (claimed.count === 0) {
      const latest = await this.findSession(workspaceId, id);
      if (latest.status === ATTACHED_STATUS) {
        return this.completedResponse(workspaceId, latest);
      }
      if (latest.status === COMPLETED_STATUS) {
        this.assertNotExpired(latest);
        return this.completedResponse(workspaceId, latest);
      }
      if (latest.status === COMPLETING_STATUS) {
        this.assertNotExpired(latest);
        return this.reconcileCompletingSession(workspaceId, latest);
      }
      this.assertNotExpired(latest);
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'A sessão mudou de estado durante a conclusão.',
      );
    }

    const claimedSession: UploadSessionRecord = {
      ...session,
      status: COMPLETING_STATUS,
    };
    let multipartCompletionAttempted = false;
    try {
      if (claimedSession.mode === MULTIPART_MODE) {
        const recovered = await this.finalizeMultipartObjectIfPresent(
          workspaceId,
          infrastructure.uploadBucket,
          claimedSession,
        );
        if (recovered) {
          return recovered;
        }
        const parts = await this.getAndValidateMultipartParts(
          infrastructure.uploadBucket,
          claimedSession,
        );
        multipartCompletionAttempted = true;
        await this.storageService.completeMultipartUpload(
          infrastructure.uploadBucket,
          claimedSession.objectKey,
          claimedSession.multipartUploadId as string,
          parts,
        );
      }

      await this.validateStoredObject(
        infrastructure.uploadBucket,
        claimedSession,
      );
      return this.markCompleted(workspaceId, claimedSession);
    } catch (error) {
      if (
        claimedSession.mode === MULTIPART_MODE &&
        multipartCompletionAttempted
      ) {
        const reconciled = await this.tryFinalizeStoredObject(
          workspaceId,
          infrastructure.uploadBucket,
          claimedSession,
        );
        if (reconciled) {
          return reconciled;
        }
      } else {
        await prisma.uploadSession.updateMany({
          where: {
            id,
            status: COMPLETING_STATUS,
            messageId: null,
          },
          data: { status: PENDING_STATUS },
        });
      }
      throw error;
    }
  }

  async getDownloadUrl(workspaceId: string, id: string): Promise<string> {
    const session = await this.findSession(workspaceId, id);
    if (session.status === COMPLETED_STATUS) {
      this.assertNotExpired(session);
    } else if (session.status !== ATTACHED_STATUS) {
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'O upload ainda não foi concluído.',
      );
    }
    const infrastructure =
      await this.workspaceDatabases.getInfrastructure(workspaceId);
    return this.storageService.createDownloadUrl(
      infrastructure.uploadBucket,
      session.objectKey,
      session.name,
    );
  }

  async cancelSession(
    workspaceId: string,
    id: string,
  ): Promise<{ status: 'cancelled' }> {
    this.assertWorkspace(workspaceId);
    let session = await this.findSessionOrNull(workspaceId, id);
    if (!session) {
      return { status: 'cancelled' };
    }
    if (session.messageId || session.status === ATTACHED_STATUS) {
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'O arquivo já está anexado a uma mensagem e não pode ser cancelado.',
      );
    }
    if (session.status === COMPLETING_STATUS) {
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'O upload está sendo concluído.',
      );
    }

    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    if (session.status !== DELETING_STATUS) {
      const claimed = await prisma.uploadSession.updateMany({
        where: {
          id,
          messageId: null,
          status: { in: [PENDING_STATUS, COMPLETED_STATUS] },
        },
        data: { status: DELETING_STATUS },
      });
      if (claimed.count === 0) {
        const latest = await this.findSessionOrNull(workspaceId, id);
        if (!latest) {
          return { status: 'cancelled' };
        }
        if (
          latest.messageId ||
          latest.status === ATTACHED_STATUS ||
          latest.status === COMPLETING_STATUS
        ) {
          throw this.conflict(
            UploadErrorCode.InvalidState,
            'A sessão mudou de estado e não pode ser cancelada.',
          );
        }
        session = latest;
      } else {
        session = { ...session, status: DELETING_STATUS };
      }
    }

    const infrastructure =
      await this.workspaceDatabases.getInfrastructure(workspaceId);
    if (session.multipartUploadId) {
      await this.storageService.abortMultipartUpload(
        infrastructure.uploadBucket,
        session.objectKey,
        session.multipartUploadId,
      );
    }
    await this.storageService.deleteUploadedObject(
      infrastructure.uploadBucket,
      session.objectKey,
    );
    await prisma.uploadSession.deleteMany({
      where: { id, status: DELETING_STATUS, messageId: null },
    });
    return { status: 'cancelled' };
  }

  private async getAndValidateMultipartParts(
    bucketName: string,
    session: UploadSessionRecord,
  ): Promise<UploadedPart[]> {
    if (
      !session.multipartUploadId ||
      !session.partCount ||
      session.partSize === null
    ) {
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'A sessão multipart não possui os dados necessários.',
      );
    }
    const parts = await this.storageService.listMultipartParts(
      bucketName,
      session.objectKey,
      session.multipartUploadId,
    );
    if (parts.length !== session.partCount) {
      throw this.badRequest(
        UploadErrorCode.Incomplete,
        'Nem todas as partes do arquivo foram enviadas.',
      );
    }
    for (let index = 0; index < parts.length; index += 1) {
      const expectedPartNumber = index + 1;
      const part = parts[index];
      if (
        part.partNumber !== expectedPartNumber ||
        part.size !== this.expectedPartSize(session, expectedPartNumber)
      ) {
        throw this.badRequest(
          UploadErrorCode.Incomplete,
          'As partes armazenadas não correspondem ao arquivo declarado.',
        );
      }
    }
    return parts;
  }

  private async validateStoredObject(
    bucketName: string,
    session: UploadSessionRecord,
  ): Promise<void> {
    let metadata: { size: number | undefined; contentType: string | undefined };
    try {
      metadata = await this.storageService.getUploadedObjectMetadata(
        bucketName,
        session.objectKey,
      );
    } catch (error) {
      if (this.storageService.isNotFoundError(error)) {
        throw this.badRequest(
          UploadErrorCode.Incomplete,
          'O arquivo ainda não foi encontrado no armazenamento.',
        );
      }
      throw error;
    }

    this.validateStoredMetadata(session, metadata);
  }

  private validateStoredMetadata(
    session: UploadSessionRecord,
    metadata: { size: number | undefined; contentType: string | undefined },
  ): void {
    if (metadata.size !== this.sizeAsNumber(session.size)) {
      throw this.badRequest(
        UploadErrorCode.SizeMismatch,
        'O tamanho enviado não corresponde ao arquivo.',
      );
    }
    if (metadata.contentType && metadata.contentType !== session.type) {
      throw this.badRequest(
        UploadErrorCode.TypeMismatch,
        'O tipo enviado não corresponde ao arquivo.',
      );
    }
  }

  private async finalizeMultipartObjectIfPresent(
    workspaceId: string,
    bucketName: string,
    session: UploadSessionRecord,
  ): Promise<UploadSessionResponse | null> {
    try {
      const metadata = await this.storageService.getUploadedObjectMetadata(
        bucketName,
        session.objectKey,
      );
      this.validateStoredMetadata(session, metadata);
      return this.markCompleted(workspaceId, session);
    } catch (error) {
      if (this.storageService.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async markCompleted(
    workspaceId: string,
    session: UploadSessionRecord,
  ): Promise<UploadSessionResponse> {
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    const completedAt = new Date();
    const expiresAt = this.nextSessionExpiration();
    const updated = await prisma.uploadSession.updateMany({
      where: {
        id: session.id,
        status: COMPLETING_STATUS,
        messageId: null,
        expiresAt: { gt: new Date() },
      },
      data: { status: COMPLETED_STATUS, completedAt, expiresAt },
    });
    if (updated.count === 0) {
      const latest = await this.findSession(workspaceId, session.id);
      if (latest.status === ATTACHED_STATUS) {
        return this.completedResponse(workspaceId, latest);
      }
      if (latest.status === COMPLETED_STATUS) {
        this.assertNotExpired(latest);
        return this.completedResponse(workspaceId, latest);
      }
      this.assertNotExpired(latest);
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'A sessão mudou de estado durante a conclusão.',
      );
    }
    return this.completedResponse(workspaceId, {
      ...session,
      status: COMPLETED_STATUS,
      completedAt,
      expiresAt,
    });
  }

  private async reconcileCompletingSession(
    workspaceId: string,
    session: UploadSessionRecord,
  ): Promise<UploadSessionResponse> {
    const infrastructure =
      await this.workspaceDatabases.getInfrastructure(workspaceId);
    let reconciled = await this.tryFinalizeStoredObject(
      workspaceId,
      infrastructure.uploadBucket,
      session,
    );
    if (reconciled) {
      return reconciled;
    }

    if (session.mode === MULTIPART_MODE) {
      try {
        const parts = await this.getAndValidateMultipartParts(
          infrastructure.uploadBucket,
          session,
        );
        await this.storageService.completeMultipartUpload(
          infrastructure.uploadBucket,
          session.objectKey,
          session.multipartUploadId as string,
          parts,
        );
        await this.validateStoredObject(infrastructure.uploadBucket, session);
        return this.markCompleted(workspaceId, session);
      } catch {
        // CompleteMultipartUpload can succeed even when its response is lost.
        // A final HEAD makes a concurrent or ambiguous completion idempotent.
        reconciled = await this.tryFinalizeStoredObject(
          workspaceId,
          infrastructure.uploadBucket,
          session,
        );
        if (reconciled) {
          return reconciled;
        }
      }
    }

    throw this.conflict(
      UploadErrorCode.InvalidState,
      'A conclusão deste upload ainda está em andamento.',
    );
  }

  private async tryFinalizeStoredObject(
    workspaceId: string,
    bucketName: string,
    session: UploadSessionRecord,
  ): Promise<UploadSessionResponse | null> {
    try {
      await this.validateStoredObject(bucketName, session);
      return await this.markCompleted(workspaceId, session);
    } catch {
      return null;
    }
  }

  private async resolveRenewalRace(
    workspaceId: string,
    id: string,
  ): Promise<UploadSessionResponse> {
    const latest = await this.findSession(workspaceId, id);
    this.assertPendingAndActive(latest, SINGLE_MODE);
    throw this.conflict(
      UploadErrorCode.InvalidState,
      'A sessão mudou de estado durante a renovação.',
    );
  }

  private assertPendingAndActive(
    session: UploadSessionRecord,
    expectedMode: UploadModeValue,
  ): void {
    this.assertNotExpired(session);
    if (
      session.mode !== expectedMode ||
      session.status !== PENDING_STATUS ||
      session.messageId
    ) {
      throw this.conflict(
        UploadErrorCode.InvalidState,
        'Esta sessão não aceita esta operação.',
      );
    }
  }

  private assertNotExpired(session: UploadSessionRecord): void {
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new GoneException({
        code: UploadErrorCode.SessionExpired,
        message: 'A sessão de upload expirou.',
      });
    }
  }

  private async findSession(
    workspaceId: string,
    id: string,
  ): Promise<UploadSessionRecord> {
    this.assertWorkspace(workspaceId);
    const session = await this.findSessionOrNull(workspaceId, id);
    if (!session) {
      throw new NotFoundException({
        code: UploadErrorCode.NotFound,
        message: 'Sessão de upload não encontrada.',
      });
    }
    return session;
  }

  private async findSessionOrNull(
    workspaceId: string,
    id: string,
  ): Promise<UploadSessionRecord | null> {
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    return prisma.uploadSession.findFirst({
      where: {
        id,
        thread: { workspaceId },
      },
    });
  }

  private assertWorkspace(workspaceId: string): void {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
      throw this.badRequest(
        UploadErrorCode.InvalidRequest,
        'O workspace do upload é obrigatório.',
      );
    }
  }

  private async createSingleUploadUrl(
    bucketName: string,
    session: UploadSessionRecord,
  ): Promise<{
    uploadUrl: string;
    uploadHeaders: Record<string, string>;
    uploadUrlExpiresAt: string;
  }> {
    const ttlSeconds = this.getUploadUrlTtlSeconds();
    const uploadUrl = await this.storageService.createUploadUrl(
      bucketName,
      session.objectKey,
      session.type,
      this.sizeAsNumber(session.size),
      ttlSeconds,
    );
    return {
      uploadUrl,
      uploadHeaders: {
        'Content-Type': session.type,
        'If-None-Match': '*',
      },
      uploadUrlExpiresAt: new Date(
        Date.now() + ttlSeconds * 1000,
      ).toISOString(),
    };
  }

  private completedResponse(
    workspaceId: string,
    session: UploadSessionRecord,
  ): UploadSessionResponse {
    return this.toResponse(session, {
      downloadUrl: this.getDownloadPath(workspaceId, session.id),
    });
  }

  private toResponse(
    session: UploadSessionRecord,
    extra: Partial<UploadSessionResponse> = {},
  ): UploadSessionResponse {
    return {
      id: session.id,
      threadId: session.threadId,
      name: session.name,
      size: this.sizeAsNumber(session.size),
      type: session.type,
      status: session.status,
      mode: session.mode,
      category: session.category,
      expiresAt: session.expiresAt.toISOString(),
      completedAt: session.completedAt?.toISOString(),
      partSize:
        session.partSize === null
          ? undefined
          : this.sizeAsNumber(session.partSize),
      partCount: session.partCount ?? undefined,
      ...extra,
    };
  }

  private expectedPartSize(
    session: UploadSessionRecord,
    partNumber: number,
  ): number {
    const partSize = this.sizeAsNumber(session.partSize as bigint | number);
    if (partNumber < (session.partCount as number)) {
      return partSize;
    }
    return (
      this.sizeAsNumber(session.size) -
      partSize * ((session.partCount as number) - 1)
    );
  }

  private getCategory(contentType: string): UploadCategoryValue {
    return /^(image|audio|video)\//.test(contentType)
      ? MEDIA_CATEGORY
      : DOCUMENT_CATEGORY;
  }

  private getDocumentMaxSize(): number {
    return Math.min(
      this.readPositiveInteger(
        process.env.UPLOAD_DOCUMENT_MAX_FILE_SIZE_BYTES ||
          process.env.UPLOAD_SINGLE_MAX_SIZE_BYTES ||
          process.env.UPLOAD_DOCUMENT_MAX_SIZE_BYTES ||
          process.env.UPLOAD_MAX_FILE_SIZE_BYTES,
        DEFAULT_SINGLE_MAX_SIZE,
      ),
      DEFAULT_SINGLE_MAX_SIZE,
    );
  }

  private getMediaMaxSize(): number {
    return Math.min(
      this.readPositiveInteger(
        process.env.UPLOAD_MEDIA_MAX_FILE_SIZE_BYTES ||
          process.env.UPLOAD_MEDIA_MAX_SIZE_BYTES,
        DEFAULT_MEDIA_MAX_SIZE,
      ),
      DEFAULT_MEDIA_MAX_SIZE,
    );
  }

  private getMultipartThreshold(): number {
    return Math.min(
      this.readPositiveInteger(
        process.env.UPLOAD_MULTIPART_THRESHOLD_BYTES,
        DEFAULT_SINGLE_MAX_SIZE,
      ),
      DEFAULT_SINGLE_MAX_SIZE,
    );
  }

  private getMultipartPartSize(): number {
    return Math.min(
      this.readPositiveInteger(
        process.env.UPLOAD_MULTIPART_PART_SIZE_BYTES,
        DEFAULT_MULTIPART_PART_SIZE,
      ),
      DEFAULT_MULTIPART_PART_SIZE,
    );
  }

  private getMaxAttachments(): number {
    return Math.min(
      this.readPositiveInteger(
        process.env.UPLOAD_MAX_ATTACHMENTS,
        MAX_ACTIVE_SESSIONS_PER_THREAD,
      ),
      MAX_ACTIVE_SESSIONS_PER_THREAD,
    );
  }

  private sessionLimitException(maxActiveSessions: number): HttpException {
    return new HttpException(
      {
        code: UploadErrorCode.SessionLimit,
        message: `A conversa permite no máximo ${maxActiveSessions} uploads ativos.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private isSerializationConflict(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2034'
    );
  }

  private getUploadUrlTtlSeconds(): number {
    return Math.min(
      this.readPositiveInteger(
        process.env.UPLOAD_URL_TTL_SECONDS,
        DEFAULT_UPLOAD_URL_TTL_SECONDS,
      ),
      DEFAULT_UPLOAD_URL_TTL_SECONDS,
    );
  }

  private nextSessionExpiration(): Date {
    const ttlSeconds = Math.min(
      this.readPositiveInteger(
        process.env.UPLOAD_SESSION_TTL_SECONDS,
        DEFAULT_SESSION_TTL_SECONDS,
      ),
      DEFAULT_SESSION_TTL_SECONDS,
    );
    return new Date(Date.now() + ttlSeconds * 1000);
  }

  private getDownloadPath(workspaceId: string, id: string): string {
    return `/api/uploads/${id}/download?workspaceId=${encodeURIComponent(workspaceId)}`;
  }

  private sanitizeFileName(fileName: string): string {
    const withoutPath = fileName.split(/[\\/]/).pop() || 'arquivo';
    return (
      withoutPath
        .replace(/[^\p{L}\p{N}._-]+/gu, '_')
        .replace(/^\.+/, '')
        .slice(-180) || 'arquivo'
    );
  }

  private sizeAsNumber(value: bigint | number): number {
    const size = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isSafeInteger(size)) {
      throw new Error('Upload size cannot be represented as a JSON number.');
    }
    return size;
  }

  private readPositiveInteger(
    value: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private badRequest(code: string, message: string): BadRequestException {
    return new BadRequestException({ code, message });
  }

  private conflict(code: string, message: string): ConflictException {
    return new ConflictException({ code, message });
  }
}
