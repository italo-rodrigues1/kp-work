import { Global, Module } from '@nestjs/common';
import { StorageService } from '../chat/storage.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspaceDatabaseService } from './workspace-database.service';
import { WorkspacesService } from './workspaces.service';

@Global()
@Module({
  controllers: [WorkspacesController],
  providers: [StorageService, WorkspaceDatabaseService, WorkspacesService],
  exports: [StorageService, WorkspaceDatabaseService, WorkspacesService],
})
export class WorkspacesModule {}
