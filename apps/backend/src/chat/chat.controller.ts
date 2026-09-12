import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/chat-message.dto';
import { StreamChunkDto } from './dto/stream-chunk.dto';
import { ChatGateway } from './chat.gateway';

@Controller('api/chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Get('health')
  healthCheck() {
    return { status: 'ok', service: 'NestJS AI Chat Service' };
  }

  @Post()
  async sendMessage(@Body() dto: SendMessageDto) {
    return this.chatService.processMessage(dto);
  }

  @Post('stream-chunk')
  async receiveStreamChunk(
    @Body() dto: StreamChunkDto,
    @Headers('x-agent-callback-token') callbackToken?: string,
  ) {
    if (!this.validCallbackToken(callbackToken)) {
      throw new UnauthorizedException('Callback interno não autorizado.');
    }
    await this.chatGateway.handleStreamChunk(dto);
    return { status: 'received', threadId: dto.threadId };
  }

  private validCallbackToken(candidate?: string): boolean {
    const configured = process.env.AGENT_CALLBACK_TOKEN?.trim();
    if (!configured && process.env.NODE_ENV === 'production') return false;
    const expected = configured || 'chat-ai-agent-callback-local';
    if (!candidate) return false;

    const expectedBuffer = Buffer.from(expected);
    const candidateBuffer = Buffer.from(candidate);
    return (
      expectedBuffer.length === candidateBuffer.length &&
      timingSafeEqual(expectedBuffer, candidateBuffer)
    );
  }
}
