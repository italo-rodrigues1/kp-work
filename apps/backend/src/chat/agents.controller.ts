import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/agent.dto';

@Controller('api/workspaces/:workspaceId/agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get()
  findAll(@Param('workspaceId') workspaceId: string) {
    return this.agentsService.findAll(workspaceId);
  }

  @Post()
  create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateAgentDto,
  ) {
    return this.agentsService.create(workspaceId, dto);
  }
}
