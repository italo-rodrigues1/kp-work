import { UnauthorizedException } from '@nestjs/common';
import { ChatController } from './chat.controller';

describe('ChatController agent callback', () => {
  const originalCallbackToken = process.env.AGENT_CALLBACK_TOKEN;
  const chatGateway = { handleStreamChunk: jest.fn() };
  const controller = new ChatController({} as never, chatGateway as never);
  const payload = {
    workspaceId: 'workspace-a',
    threadId: 'thread-a',
    userMessageId: 'message-a',
    isDone: true,
    accumulated: 'Resposta',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_CALLBACK_TOKEN = 'callback-test-secret';
    chatGateway.handleStreamChunk.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalCallbackToken === undefined) {
      delete process.env.AGENT_CALLBACK_TOKEN;
    } else {
      process.env.AGENT_CALLBACK_TOKEN = originalCallbackToken;
    }
  });

  it('recusa callbacks sem o segredo interno', async () => {
    await expect(
      controller.receiveStreamChunk(payload, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.receiveStreamChunk(payload, 'segredo-incorreto'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(chatGateway.handleStreamChunk).not.toHaveBeenCalled();
  });

  it('encaminha o callback autenticado para a workspace declarada', async () => {
    await expect(
      controller.receiveStreamChunk(payload, 'callback-test-secret'),
    ).resolves.toEqual({ status: 'received', threadId: 'thread-a' });

    expect(chatGateway.handleStreamChunk).toHaveBeenCalledWith(payload);
  });
});
