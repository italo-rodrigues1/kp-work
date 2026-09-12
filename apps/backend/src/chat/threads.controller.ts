import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
} from '@nestjs/common';
import { ThreadsService } from './threads.service';
import { CreateThreadDto, UpdateThreadDto } from './dto/thread.dto';

@Controller('api/workspaces/:workspaceId/threads')
export class ThreadsController {
  constructor(private readonly threadsService: ThreadsService) {}

  @Get()
  async findAll(@Param('workspaceId') workspaceId: string) {
    return this.threadsService.findAll(workspaceId);
  }

  @Get(':id')
  async findOne(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.threadsService.findOne(workspaceId, id);
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateThreadDto,
  ) {
    return this.threadsService.create(workspaceId, dto);
  }

  @Patch(':id')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateThreadDto,
  ) {
    return this.threadsService.update(workspaceId, id, dto);
  }

  @Delete(':id')
  async remove(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.threadsService.remove(workspaceId, id);
  }
}
