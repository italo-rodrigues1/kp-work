import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SendMessageDto } from './dto/chat-message.dto';
import { EventsService } from './events.service';
import { StorageService, AgentContextPayload } from './storage.service';
import { RabbitMQService, AgentTaskMessage } from './rabbitmq.service';
import { WorkspaceDatabaseService } from '../workspaces/workspace-database.service';

export interface StreamChunkPayload {
  workspaceId: string;
  threadId: string;
  userMessageId: string;
  chunk?: string;
  accumulated?: string;
  isDone?: boolean;
  model?: string;
  toolCalls?: Array<Record<string, unknown>>;
  workingMemoryContext?: Record<string, unknown>;
  error?: string;
}

const ABSOLUTE_MAX_ATTACHMENTS_PER_MESSAGE = 10;

function maxAttachmentsPerMessage(): number {
  const configured = Number(process.env.UPLOAD_MAX_ATTACHMENTS);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, ABSOLUTE_MAX_ATTACHMENTS_PER_MESSAGE)
    : ABSOLUTE_MAX_ATTACHMENTS_PER_MESSAGE;
}

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
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly workspaceDatabases: WorkspaceDatabaseService,
    private readonly eventsService: EventsService,
    private readonly storageService: StorageService,
    private readonly rabbitmqService: RabbitMQService,
  ) {}

  async saveUserMessage(dto: SendMessageDto) {
    const workspaceId = dto.workspaceId?.trim();
    if (!workspaceId) {
      throw new BadRequestException('O workspace da mensagem é obrigatório.');
    }
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);

    let threadId = dto.threadId;

    if (!threadId) {
      const newThread = await prisma.thread.create({
        data: {
          title: dto.message
            ? dto.message.slice(0, 25) + (dto.message.length > 25 ? '...' : '')
            : 'Nova Conversa',
          model: dto.model || 'openai/gpt-4o',
          workspaceId,
        },
      });
      threadId = newThread.id;
    } else {
      const existingThread = await prisma.thread.findFirst({
        where: { id: threadId, workspaceId },
        select: { id: true },
      });
      if (!existingThread) {
        throw new NotFoundException('Conversa não encontrada neste workspace.');
      }
    }

    const content =
      dto.message || (dto.hasAudio ? '🎙️ Mensagem de áudio' : 'Anexo enviado');
    const attachmentDtos = dto.attachments ?? [];
    if (!Array.isArray(attachmentDtos)) {
      throw new BadRequestException({
        code: 'UPLOAD_ATTACHMENT_IDS_INVALID',
        message: 'A lista de anexos é inválida.',
      });
    }

    const maxAttachments = maxAttachmentsPerMessage();
    if (attachmentDtos.length > maxAttachments) {
      throw new BadRequestException({
        code: 'UPLOAD_ATTACHMENT_LIMIT_EXCEEDED',
        message: `Cada mensagem aceita no máximo ${maxAttachments} anexos.`,
      });
    }

    const uploadSessionIds = attachmentDtos.map((attachment) =>
      typeof attachment?.uploadSessionId === 'string'
        ? attachment.uploadSessionId.trim()
        : '',
    );

    if (uploadSessionIds.some((id) => !id)) {
      throw new BadRequestException({
        code: 'UPLOAD_ATTACHMENT_IDS_INVALID',
        message: 'Todos os anexos devem informar uma sessão de upload.',
      });
    }

    if (new Set(uploadSessionIds).size !== uploadSessionIds.length) {
      throw new BadRequestException({
        code: 'UPLOAD_ATTACHMENT_IDS_DUPLICATED',
        message: 'Uma sessão de upload não pode ser anexada mais de uma vez.',
      });
    }

    const targetThreadId = threadId;
    const attachmentCutoff = new Date();
    const persistedMessage = await prisma.$transaction(
      async (tx) => {
        const foundUploads = uploadSessionIds.length
          ? await tx.uploadSession.findMany({
              where: { id: { in: uploadSessionIds } },
              select: {
                id: true,
                threadId: true,
                messageId: true,
                name: true,
                size: true,
                type: true,
                status: true,
                expiresAt: true,
              },
            })
          : [];

        if (
          foundUploads.length !== uploadSessionIds.length ||
          foundUploads.some((upload) => upload.threadId !== targetThreadId)
        ) {
          throw new BadRequestException({
            code: 'UPLOAD_SESSION_INVALID_SCOPE',
            message:
              'Um ou mais uploads não existem ou pertencem a outra conversa ou workspace.',
          });
        }

        if (
          foundUploads.some(
            (upload) =>
              upload.expiresAt.getTime() <= attachmentCutoff.getTime(),
          )
        ) {
          throw new GoneException({
            code: 'UPLOAD_SESSION_EXPIRED',
            message: 'Uma ou mais sessões de upload expiraram.',
          });
        }

        if (
          foundUploads.some(
            (upload) =>
              upload.status !== 'COMPLETED' || upload.messageId !== null,
          )
        ) {
          throw new ConflictException({
            code: 'UPLOAD_SESSION_INVALID_STATE',
            message:
              'Todos os uploads devem estar concluídos e ainda não anexados.',
          });
        }

        const uploadsById = new Map(
          foundUploads.map((upload) => [upload.id, upload]),
        );
        const uploads = uploadSessionIds.map((uploadSessionId) =>
          uploadsById.get(uploadSessionId)!,
        );

        const message = await tx.message.create({
          data: {
            threadId: targetThreadId,
            sender: 'user',
            content,
            model: dto.model,
            attachments: uploads.length
              ? {
                  create: uploads.map((upload) => ({
                    name: upload.name,
                    size: upload.size,
                    type: upload.type,
                    url: `/api/uploads/${upload.id}/download?workspaceId=${encodeURIComponent(workspaceId)}`,
                  })),
                }
              : undefined,
            audio: dto.audio
              ? {
                  create: {
                    url: dto.audio.url,
                    durationSeconds: dto.audio.durationSeconds,
                  },
                }
              : undefined,
          },
          include: {
            attachments: true,
            audio: true,
          },
        });

        if (uploads.length) {
          const attachedAt = new Date();
          const attached = await tx.uploadSession.updateMany({
            where: {
              id: { in: uploadSessionIds },
              threadId: targetThreadId,
              status: 'COMPLETED',
              messageId: null,
              expiresAt: { gt: attachmentCutoff },
            },
            data: {
              status: 'ATTACHED',
              messageId: message.id,
              attachedAt,
            },
          });
          if (attached.count !== uploads.length) {
            throw new ConflictException({
              code: 'UPLOAD_SESSION_CONFLICT',
              message:
                'Um dos uploads expirou, foi cancelado ou já foi anexado.',
            });
          }
        }

        return message;
      },
      { isolationLevel: 'Serializable' },
    );
    const userMessage = serializeBigInts(persistedMessage);

    return { userMessage, threadId, workspaceId };
  }

  async saveAssistantMessage(
    workspaceId: string,
    threadId: string,
    content: string,
    model?: string,
    responseToUserMessageId?: string,
  ) {
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    const thread = await prisma.thread.findFirst({
      where: { id: threadId, workspaceId },
      select: { id: true },
    });
    if (!thread) {
      throw new NotFoundException('Conversa não encontrada neste workspace.');
    }

    const messageData = {
      threadId,
      sender: 'assistant',
      content,
      model,
      isStreaming: false,
    };
    const persistedMessage = responseToUserMessageId
      ? await prisma.message.upsert({
          where: {
            id: this.agentResponseMessageId(responseToUserMessageId),
          },
          create: {
            id: this.agentResponseMessageId(responseToUserMessageId),
            ...messageData,
          },
          update: messageData,
          include: {
            attachments: true,
            audio: true,
          },
        })
      : await prisma.message.create({
          data: messageData,
          include: {
            attachments: true,
            audio: true,
          },
        });

    // Touch thread updatedAt
    await prisma.thread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });

    return serializeBigInts(persistedMessage);
  }

  async dispatchToAgentTimeline(
    workspaceId: string,
    threadId: string,
    userMessageId: string,
    prompt: string,
    model?: string,
  ): Promise<boolean> {
    try {
      const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
      const infrastructure =
        await this.workspaceDatabases.getInfrastructure(workspaceId);
      // 1. Fetch chat history for context
      const history = await prisma.message.findMany({
        where: { threadId, thread: { workspaceId } },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });

      // 2. Build Agent Context Payload
      const contextPayload: AgentContextPayload = {
        workspaceId,
        threadId,
        messageId: userMessageId,
        userPrompt: prompt,
        model: model || 'openai/gpt-4o',
        systemPrompt:
          'Você é um assistente de IA operando sob a arquitetura Harness com memórias e ferramentas.',
        allowedTools: [
          'schedule_meeting',
          'crm_read_write',
          'fetch_payment_info',
        ],
        chatHistory: history.map((m) => ({
          sender: m.sender,
          content: m.content,
        })),
        createdAt: new Date().toISOString(),
      };

      // 3. Save JSON context in MinIO S3 Blob Storage
      const blobKey = `agent-context/${workspaceId}/${threadId}/${userMessageId}.json`;
      await this.storageService.saveAgentContext(
        infrastructure.contextBucket,
        blobKey,
        contextPayload,
      );

      // 4. Dispatch lightweight task to RabbitMQ
      const taskMessage: AgentTaskMessage = {
        workspaceId,
        threadId,
        userMessageId,
        blobBucket: infrastructure.contextBucket,
        blobKey,
        createdAt: new Date().toISOString(),
      };

      return await this.rabbitmqService.dispatchTask(taskMessage);
    } catch (err) {
      this.logger.error(`Error dispatching to Agent Timeline:`, err);
      return false;
    }
  }

  async processMessage(dto: SendMessageDto) {
    this.logger.log(
      `Received HTTP message request for thread [${dto.threadId || 'new'}]: ${dto.message}`,
    );

    const { userMessage, threadId, workspaceId } =
      await this.saveUserMessage(dto);

    // Attempt dispatch to Agent Timeline via RabbitMQ & MinIO Blob
    const dispatched = await this.dispatchToAgentTimeline(
      workspaceId,
      threadId,
      userMessage.id,
      userMessage.content,
      dto.model,
    );

    if (dispatched) {
      this.eventsService.emitNotification(
        'Tarefa Despachada',
        `Mensagem despachada via RabbitMQ para o Agent Timeline (thread ${threadId}).`,
        threadId,
        workspaceId,
      );
      return {
        threadId,
        userMessage,
        status: 'dispatched',
        timestamp: userMessage.createdAt.toISOString(),
      };
    }

    // Fallback response if dispatch fails
    const attachmentsCount = dto.attachments
      ? dto.attachments.length
      : dto.attachmentsCount || 0;
    const replyParts = this.buildReplyParts(
      dto.message,
      attachmentsCount,
      Boolean(dto.hasAudio || dto.audio),
      dto.model,
    );
    const replyContent = replyParts.join('\n\n');

    const assistantMessage = await this.saveAssistantMessage(
      workspaceId,
      threadId,
      replyContent,
      dto.model,
    );

    this.eventsService.emitNotification(
      'Mensagem Processada (Fallback)',
      `Mensagem salva no banco de dados para a thread ${threadId}.`,
      threadId,
      workspaceId,
    );

    return {
      threadId,
      userMessage,
      assistantMessage,
      reply: replyContent,
      status: 'success_fallback',
      timestamp: assistantMessage.createdAt.toISOString(),
    };
  }

  async ensureThreadInWorkspace(workspaceId: string, threadId: string) {
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    const thread = await prisma.thread.findFirst({
      where: { id: threadId, workspaceId },
      select: { id: true },
    });
    if (!thread) {
      throw new NotFoundException('Conversa não encontrada neste workspace.');
    }
    return thread;
  }

  async ensureUserMessageInWorkspace(
    workspaceId: string,
    threadId: string,
    userMessageId: string,
  ) {
    if (!userMessageId?.trim()) {
      throw new BadRequestException(
        'A mensagem de origem do callback é obrigatória.',
      );
    }
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    const message = await prisma.message.findFirst({
      where: {
        id: userMessageId,
        sender: 'user',
        thread: { id: threadId, workspaceId },
      },
      select: { id: true },
    });
    if (!message) {
      throw new NotFoundException(
        'Mensagem de origem não encontrada nesta conversa e workspace.',
      );
    }
    return message;
  }

  private agentResponseMessageId(userMessageId: string): string {
    return `agent-response:${userMessageId}`;
  }

  buildReplyParts(
    message?: string,
    attachmentsCount?: number,
    hasAudio?: boolean,
    model?: string,
  ): string[] {
    const replyParts: string[] = [];
    let modelName = model || 'OpenRouter AI';

    if (model) {
      const lower = model.toLowerCase();
      if (lower.includes('gpt-4o-mini')) {
        modelName = 'OpenRouter (GPT-4o Mini)';
      } else if (lower.includes('gpt-4o')) {
        modelName = 'OpenRouter (GPT-4o)';
      } else if (lower.includes('claude')) {
        modelName = 'OpenRouter (Claude 3.5 Sonnet)';
      } else if (lower.includes('gemini')) {
        modelName = 'OpenRouter (Gemini 2.5 Flash)';
      } else if (lower.includes('deepseek')) {
        modelName = 'OpenRouter (DeepSeek V3)';
      } else if (lower.includes('qwen')) {
        modelName = 'OpenRouter (Qwen 2.5 72B)';
      } else if (lower.includes('llama')) {
        modelName = 'OpenRouter (Llama 3.3 70B)';
      }
    }

    if (hasAudio) {
      replyParts.push('🎙️ Áudio de voz processado e armazenado com sucesso!');
    }

    if (attachmentsCount && attachmentsCount > 0) {
      replyParts.push(
        `📎 ${attachmentsCount} arquivo(s) anexo(s) armazenado(s).`,
      );
    }

    if (message && message.trim()) {
      replyParts.push(
        `🤖 Resposta gerada via **${modelName}**.\n\nEm resposta à sua mensagem: "${message.trim()}", o dado foi persistido no banco de dados.`,
      );
    } else if (!hasAudio && !attachmentsCount) {
      replyParts.push(
        `🤖 Olá! Sou o assistente **${modelName}**. Como posso te ajudar hoje?`,
      );
    }

    return replyParts;
  }
}
