import { BadRequestException, Injectable } from '@nestjs/common';
import { WorkspaceDatabaseService } from '../workspaces/workspace-database.service';
import { CreateAgentDto } from './dto/agent.dto';

@Injectable()
export class AgentsService {
  constructor(private readonly workspaceDatabases: WorkspaceDatabaseService) {}

  async findAll(workspaceId: string) {
    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    return prisma.agent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(workspaceId: string, dto: CreateAgentDto) {
    const name = this.requiredText(dto.name, 'nome', 80);
    const description = this.requiredText(dto.description, 'descrição', 500);
    const instructions = dto.instructions?.trim() || '';
    const model = this.requiredText(dto.model, 'modelo', 120);
    const tools = Array.isArray(dto.tools)
      ? dto.tools
          .filter((tool): tool is string => typeof tool === 'string')
          .map((tool) => tool.trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];

    if (instructions.length > 10_000) {
      throw new BadRequestException(
        'As instruções devem ter no máximo 10.000 caracteres.',
      );
    }

    const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
    return prisma.agent.create({
      data: {
        workspaceId,
        name,
        description,
        instructions,
        model,
        tools,
      },
    });
  }

  private requiredText(value: string | undefined, field: string, max: number) {
    const normalized = value?.trim();
    if (!normalized) {
      throw new BadRequestException(`O ${field} do agente é obrigatório.`);
    }
    if (normalized.length > max) {
      throw new BadRequestException(
        `O ${field} do agente deve ter no máximo ${max} caracteres.`,
      );
    }
    return normalized;
  }
}
