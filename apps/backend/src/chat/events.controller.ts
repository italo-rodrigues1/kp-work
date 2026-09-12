import { Controller, Sse, MessageEvent, Query } from '@nestjs/common';
import { Observable } from 'rxjs';
import { EventsService } from './events.service';

@Controller('api/events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Sse('sse')
  streamEvents(
    @Query('workspaceId') workspaceId: string,
  ): Observable<MessageEvent> {
    return this.eventsService.getEventObservable(workspaceId);
  }
}
