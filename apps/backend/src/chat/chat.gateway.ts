import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  Ack,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { StreamChunkDto } from './dto/stream-chunk.dto';
import { EventsService } from './events.service';
import { AttachmentDto, AudioDto } from './dto/chat-message.dto';

const frontendOrigins = (
  process.env.FRONTEND_ORIGINS ||
  'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

interface SendMessagePayload {
  workspaceId: string;
  threadId: string;
  message?: string;
  model: string;
  attachmentsCount?: number;
  hasAudio?: boolean;
  attachments?: AttachmentDto[];
  audio?: AudioDto;
}

type SendMessageAck =
  | {
      ok: true;
      workspaceId: string;
      threadId: string;
      userMessage: unknown;
    }
  | { ok: false; message: string };

@WebSocketGateway({
  cors: {
    origin: frontendOrigins,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly eventsService: EventsService,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected via WebSocket: ${client.id}`);
    this.eventsService.emitStatus(
      `Novo cliente conectado via WebSocket: ${client.id}`,
    );
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from WebSocket: ${client.id}`);
    this.eventsService.emitStatus(
      `Cliente desconectado do WebSocket: ${client.id}`,
    );
  }

  @SubscribeMessage('join_thread')
  async handleJoinThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { workspaceId: string; threadId: string },
  ) {
    if (data?.workspaceId && data?.threadId) {
      await this.chatService.ensureThreadInWorkspace(
        data.workspaceId,
        data.threadId,
      );
      const room = this.threadRoom(data.workspaceId, data.threadId);
      await client.join(room);
      this.logger.log(
        `Client ${client.id} joined thread room: ${data.threadId}`,
      );
      client.emit('joined_thread', {
        workspaceId: data.workspaceId,
        threadId: data.threadId,
        status: 'success',
      });
      this.eventsService.emitStatus(
        `Cliente ingressou na thread: ${data.threadId}`,
        data.threadId,
        data.workspaceId,
      );
    }
  }

  @SubscribeMessage('leave_thread')
  handleLeaveThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { workspaceId: string; threadId: string },
  ) {
    if (data?.workspaceId && data?.threadId) {
      void client.leave(this.threadRoom(data.workspaceId, data.threadId));
      this.logger.log(`Client ${client.id} left thread room: ${data.threadId}`);
    }
  }

  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SendMessagePayload,
    @Ack() acknowledge?: (response: SendMessageAck) => void,
  ) {
    const {
      workspaceId,
      threadId,
      message,
      model,
      attachmentsCount,
      hasAudio,
      attachments,
      audio,
    } = payload;
    this.logger.log(
      `WebSocket send_message in thread [${threadId}]: ${message}`,
    );

    // Persist user message in PostgreSQL DB
    let savedMessage: Awaited<ReturnType<ChatService['saveUserMessage']>>;
    try {
      savedMessage = await this.chatService.saveUserMessage({
        workspaceId,
        threadId,
        message,
        model,
        attachmentsCount,
        hasAudio,
        attachments,
        audio,
      });
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Não foi possível salvar a mensagem.';
      acknowledge?.({ ok: false, message: errorMessage });
      client.emit('message_error', {
        workspaceId,
        threadId,
        message: errorMessage,
      });
      return;
    }

    const {
      userMessage,
      threadId: targetThreadId,
      workspaceId: targetWorkspaceId,
    } = savedMessage;

    acknowledge?.({
      ok: true,
      workspaceId: targetWorkspaceId,
      threadId: targetThreadId,
      userMessage,
    });

    // Notify room of stored user message
    const room = this.threadRoom(targetWorkspaceId, targetThreadId);
    this.server.to(room).emit('user_message_saved', {
      workspaceId: targetWorkspaceId,
      threadId: targetThreadId,
      message: userMessage,
    });

    // Notify SSE about task dispatching
    this.eventsService.emitNotification(
      'Processando Mensagem',
      `Processando mensagem em tempo real para a thread ${targetThreadId} usando modelo ${model}...`,
      targetThreadId,
      targetWorkspaceId,
    );

    // Notify thread room that assistant is typing/processing
    this.server.to(room).emit('typing_status', {
      workspaceId: targetWorkspaceId,
      threadId: targetThreadId,
      isTyping: true,
    });

    // Dispatch to Agent Timeline via MinIO Blob & RabbitMQ
    const dispatched = await this.chatService.dispatchToAgentTimeline(
      targetWorkspaceId,
      targetThreadId,
      userMessage.id,
      userMessage.content,
      model,
    );

    if (dispatched) {
      this.eventsService.emitStatus(
        `Mensagem despachada via RabbitMQ para o Agent Timeline`,
        targetThreadId,
        targetWorkspaceId,
      );
      return;
    }

    // Fallback if dispatch fails: simulate streaming response
    this.logger.warn(
      `RabbitMQ dispatch failed. Falling back to local simulated streaming.`,
    );
    const replyParts = this.chatService.buildReplyParts(
      message,
      attachmentsCount || (attachments ? attachments.length : 0),
      Boolean(hasAudio || audio),
      model,
    );
    const fullReply = replyParts.join('\n\n');

    const words = fullReply.split(' ');
    let currentText = '';

    for (let i = 0; i < words.length; i++) {
      currentText += (i === 0 ? '' : ' ') + words[i];

      this.server.to(room).emit('message_chunk', {
        workspaceId: targetWorkspaceId,
        threadId: targetThreadId,
        chunk: words[i] + (i < words.length - 1 ? ' ' : ''),
        accumulated: currentText,
        isDone: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const assistantMessage = await this.chatService.saveAssistantMessage(
      targetWorkspaceId,
      targetThreadId,
      fullReply,
      model,
    );

    this.server.to(room).emit('message_complete', {
      workspaceId: targetWorkspaceId,
      threadId: targetThreadId,
      message: assistantMessage,
      content: fullReply,
      model,
      timestamp: assistantMessage.createdAt.toISOString(),
    });

    this.server.to(room).emit('typing_status', {
      workspaceId: targetWorkspaceId,
      threadId: targetThreadId,
      isTyping: false,
    });
  }

  async handleStreamChunk(payload: StreamChunkDto) {
    const {
      workspaceId,
      threadId,
      userMessageId,
      chunk,
      accumulated,
      isDone,
      model,
      toolCalls,
      workingMemoryContext,
    } = payload;

    await this.chatService.ensureUserMessageInWorkspace(
      workspaceId,
      threadId,
      userMessageId,
    );
    const room = this.threadRoom(workspaceId, threadId);

    this.logger.log(
      `Received stream chunk from Agent Timeline for thread [${threadId}], isDone: ${Boolean(isDone)}`,
    );

    // Broadcast chunk to WebSocket thread room
    this.server.to(room).emit('message_chunk', {
      workspaceId,
      threadId,
      chunk: chunk || '',
      accumulated: accumulated || '',
      isDone: Boolean(isDone),
      toolCalls,
      workingMemoryContext,
    });

    if (isDone) {
      const finalContent = accumulated || chunk || '';

      // Save assistant message to PostgreSQL DB
      const assistantMessage = await this.chatService.saveAssistantMessage(
        workspaceId,
        threadId,
        finalContent,
        model,
        userMessageId,
      );

      // Emit completion event to WebSocket room
      this.server.to(room).emit('message_complete', {
        workspaceId,
        threadId,
        message: assistantMessage,
        content: finalContent,
        model,
        timestamp: assistantMessage.createdAt.toISOString(),
        toolCalls,
        workingMemoryContext,
      });

      this.server.to(room).emit('typing_status', {
        workspaceId,
        threadId,
        isTyping: false,
      });

      this.eventsService.emitNotification(
        'Resposta do Agente Concluída',
        `Agent Timeline finalizou o processamento para a thread ${threadId}.`,
        threadId,
        workspaceId,
      );
    }
  }

  private threadRoom(workspaceId: string, threadId: string) {
    return `workspace:${workspaceId}:thread:${threadId}`;
  }
}
