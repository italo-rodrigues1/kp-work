import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';
import { RabbitMQService } from './rabbitmq.service';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { UploadCleanupService } from './upload-cleanup.service';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [
    ChatController,
    EventsController,
    ThreadsController,
    UploadsController,
    AgentsController,
  ],
  providers: [
    ChatService,
    ChatGateway,
    EventsService,
    ThreadsService,
    RabbitMQService,
    UploadsService,
    UploadCleanupService,
    AgentsService,
  ],
  exports: [
    ChatService,
    EventsService,
    ThreadsService,
    RabbitMQService,
    UploadsService,
    UploadCleanupService,
    AgentsService,
  ],
})
export class ChatModule {}
