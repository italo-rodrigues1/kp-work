import { BadRequestException } from '@nestjs/common';
import { AgentsService } from './agents.service';

describe('AgentsService workspace isolation', () => {
  const prismaMock = {
    agent: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
  };
  const workspaceDatabasesMock = {
    forWorkspace: jest.fn(),
  };
  const service = new AgentsService(workspaceDatabasesMock as never);

  beforeEach(() => {
    jest.clearAllMocks();
    workspaceDatabasesMock.forWorkspace.mockResolvedValue(prismaMock);
    prismaMock.agent.findMany.mockResolvedValue([]);
    prismaMock.agent.create.mockImplementation(
      (query: { data: Record<string, unknown> }) => query.data,
    );
  });

  it('lista agentes somente no banco e workspace solicitados', async () => {
    await service.findAll('workspace-a');

    expect(workspaceDatabasesMock.forWorkspace).toHaveBeenCalledWith(
      'workspace-a',
    );
    expect(prismaMock.agent.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-a' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('persiste o agente no banco físico da workspace', async () => {
    await service.create('workspace-b', {
      name: '  Pesquisador  ',
      description: '  Pesquisa fontes  ',
      instructions: '  Compare evidências.  ',
      model: '  openai/gpt-4o  ',
      tools: [' web ', '', 'web', 42 as never],
    });

    expect(workspaceDatabasesMock.forWorkspace).toHaveBeenCalledWith(
      'workspace-b',
    );
    expect(prismaMock.agent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-b',
        name: 'Pesquisador',
        description: 'Pesquisa fontes',
        instructions: 'Compare evidências.',
        model: 'openai/gpt-4o',
        tools: ['web', 'web'],
      },
    });
  });

  it('valida campos obrigatórios antes de abrir o banco da workspace', async () => {
    await expect(
      service.create('workspace-a', {
        name: ' ',
        description: 'Descrição',
        model: 'openai/gpt-4o',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(workspaceDatabasesMock.forWorkspace).not.toHaveBeenCalled();
  });
});
