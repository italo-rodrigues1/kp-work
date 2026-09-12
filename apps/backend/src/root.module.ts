import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { PrismaModule } from './prisma.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [PrismaModule, WorkspacesModule, ChatModule],
  controllers: [],
  providers: [],
})
export class RootModule {}
