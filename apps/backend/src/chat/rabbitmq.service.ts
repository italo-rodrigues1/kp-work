import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import * as amqp from 'amqplib';

export interface AgentTaskMessage {
  workspaceId: string;
  threadId: string;
  userMessageId: string;
  blobBucket: string;
  blobKey: string;
  createdAt: string;
}

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.Channel;
  public readonly queueName = 'agent_tasks';

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // Ignore cleanup errors
    }
  }

  private async connect() {
    try {
      const rabbitUser = process.env.RABBITMQ_DEFAULT_USER || 'rabbitmq';
      const rabbitPass =
        process.env.RABBITMQ_DEFAULT_PASS || 'rabbitmqpassword';
      const rabbitHost = process.env.RABBITMQ_HOST || 'localhost';
      const rabbitPort = process.env.RABBITMQ_PORT || '5672';
      const url = `amqp://${rabbitUser}:${rabbitPass}@${rabbitHost}:${rabbitPort}`;

      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertQueue(this.queueName, { durable: true });
      this.logger.log(
        `Connected to RabbitMQ on ${rabbitHost}:${rabbitPort}, queue [${this.queueName}] declared.`,
      );
    } catch (err) {
      this.logger.error(`Failed to connect to RabbitMQ:`, err);
    }
  }

  async dispatchTask(task: AgentTaskMessage): Promise<boolean> {
    if (!this.channel) {
      this.logger.warn(`RabbitMQ channel not initialized. Reconnecting...`);
      await this.connect();
    }

    if (!this.channel) {
      this.logger.error(`Cannot publish task, RabbitMQ channel unavailable.`);
      return false;
    }

    const payloadBuffer = Buffer.from(JSON.stringify(task));
    const published = this.channel.sendToQueue(this.queueName, payloadBuffer, {
      persistent: true,
    });

    if (published) {
      this.logger.log(
        `Dispatched agent task to RabbitMQ for thread [${task.threadId}], blobKey [${task.blobKey}]`,
      );
    }
    return published;
  }
}
