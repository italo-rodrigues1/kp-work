/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ChatGateway } from './chat.gateway';

describe('ChatGateway', () => {
  it('uses the normalized workspace returned by saveUserMessage', async () => {
    const userMessage = {
      id: 'message-1',
      content: 'Olá',
      createdAt: new Date('2026-08-22T12:00:00.000Z'),
    };
    const chatService = {
      saveUserMessage: jest.fn().mockResolvedValue({
        userMessage,
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
      }),
      dispatchToAgentTimeline: jest.fn().mockResolvedValue(true),
    };
    const eventsService = {
      emitNotification: jest.fn(),
      emitStatus: jest.fn(),
    };
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const gateway = new ChatGateway(
      chatService as never,
      eventsService as never,
    );
    gateway.server = { to } as never;

    await gateway.handleSendMessage({} as never, {
      workspaceId: ' workspace-1 ',
      threadId: 'thread-1',
      message: 'Olá',
      model: 'openai/gpt-4o',
    });

    expect(to).toHaveBeenCalledWith('workspace:workspace-1:thread:thread-1');
    expect(chatService.dispatchToAgentTimeline).toHaveBeenCalledWith(
      'workspace-1',
      'thread-1',
      'message-1',
      'Olá',
      'openai/gpt-4o',
    );
    expect(eventsService.emitNotification).toHaveBeenCalledWith(
      'Processando Mensagem',
      expect.any(String),
      'thread-1',
      'workspace-1',
    );
    expect(emit).toHaveBeenCalledWith(
      'user_message_saved',
      expect.objectContaining({ workspaceId: 'workspace-1' }),
    );
  });

  it('vincula a conclusão do worker à mensagem de usuário', async () => {
    const createdAt = new Date('2026-08-22T12:00:00.000Z');
    const chatService = {
      ensureUserMessageInWorkspace: jest.fn().mockResolvedValue({
        id: 'message-1',
      }),
      saveAssistantMessage: jest.fn().mockResolvedValue({
        id: 'agent-response:message-1',
        content: 'Resposta',
        createdAt,
      }),
    };
    const eventsService = { emitNotification: jest.fn() };
    const emit = jest.fn();
    const gateway = new ChatGateway(
      chatService as never,
      eventsService as never,
    );
    gateway.server = { to: jest.fn().mockReturnValue({ emit }) } as never;

    await gateway.handleStreamChunk({
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      userMessageId: 'message-1',
      accumulated: 'Resposta',
      isDone: true,
      model: 'openai/gpt-4o',
    });

    expect(chatService.ensureUserMessageInWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      'thread-1',
      'message-1',
    );
    expect(chatService.saveAssistantMessage).toHaveBeenCalledWith(
      'workspace-1',
      'thread-1',
      'Resposta',
      'openai/gpt-4o',
      'message-1',
    );
    expect(emit).toHaveBeenCalledWith(
      'message_complete',
      expect.objectContaining({
        workspaceId: 'workspace-1',
        message: expect.objectContaining({
          id: 'agent-response:message-1',
        }),
      }),
    );
  });
});
