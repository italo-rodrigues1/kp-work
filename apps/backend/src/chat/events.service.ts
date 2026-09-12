import { Injectable, MessageEvent } from '@nestjs/common';
import { filter, map, Observable, Subject } from 'rxjs';
import { WorkspaceDatabaseService } from '../workspaces/workspace-database.service';

export interface SSEEventData {
  type: 'status' | 'notification' | 'system' | 'ping';
  title?: string;
  message: string;
  timestamp: string;
  workspaceId?: string;
  threadId?: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class EventsService {
  private readonly events$ = new Subject<SSEEventData>();

  constructor(private readonly workspaceDatabases: WorkspaceDatabaseService) {
    // Send a periodic heartbeat ping every 15 seconds to keep SSE connection active
    setInterval(() => {
      this.emitPing();
    }, 15000);
  }

  async emitEvent(data: SSEEventData) {
    if (data.type !== 'ping') {
      try {
        let validThreadId: string | undefined = undefined;
        const workspaceId = data.workspaceId?.trim();

        if (!workspaceId) {
          this.events$.next({ ...data, workspaceId: undefined });
          return;
        }

        const prisma = await this.workspaceDatabases.forWorkspace(workspaceId);
        if (data.threadId) {
          const threadExists = await prisma.thread.findFirst({
            where: { id: data.threadId, workspaceId },
            select: { id: true, workspaceId: true },
          });
          if (threadExists) {
            validThreadId = data.threadId;
          }
        }

        const scopedEvent = { ...data, workspaceId };
        this.events$.next(scopedEvent);

        await prisma.chatEvent.create({
          data: {
            type: data.type,
            title: data.title,
            message: data.message,
            workspaceId,
            threadId: validThreadId,
            payload: data.payload ? (data.payload as object) : undefined,
          },
        });
      } catch (err) {
        console.error('Erro ao salvar evento no banco de dados:', err);
      }
      return;
    }

    this.events$.next(data);
  }

  emitNotification(
    title: string,
    message: string,
    threadId?: string,
    workspaceId?: string,
    payload?: Record<string, unknown>,
  ) {
    void this.emitEvent({
      type: 'notification',
      title,
      message,
      timestamp: new Date().toISOString(),
      workspaceId,
      threadId,
      payload,
    });
  }

  emitStatus(
    message: string,
    threadId?: string,
    workspaceId?: string,
    payload?: Record<string, unknown>,
  ) {
    void this.emitEvent({
      type: 'status',
      message,
      timestamp: new Date().toISOString(),
      workspaceId,
      threadId,
      payload,
    });
  }

  emitPing() {
    void this.emitEvent({
      type: 'ping',
      message: 'keep-alive',
      timestamp: new Date().toISOString(),
    });
  }

  getEventObservable(workspaceId: string): Observable<MessageEvent> {
    return this.events$.pipe(
      filter(
        (event) =>
          event.type === 'ping' ||
          (Boolean(workspaceId) && event.workspaceId === workspaceId),
      ),
      map((event) => ({
        data: JSON.stringify(event),
        id: `${Date.now()}`,
        type: event.type,
      })),
    );
  }
}
