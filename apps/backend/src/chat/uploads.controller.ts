import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import { CreateUploadSessionDto, UploadPartsDto } from './dto/upload.dto';
import { UploadsService } from './uploads.service';

@Controller('api/uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post()
  async createSession(@Body() dto: CreateUploadSessionDto) {
    return this.uploadsService.createSession(dto);
  }

  @Post(':id/url')
  async renewUploadUrl(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.uploadsService.renewUploadUrl(workspaceId, id);
  }

  @Post(':id/parts')
  async createPartUploadUrls(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
    @Body() dto?: UploadPartsDto,
  ) {
    return this.uploadsService.createPartUploadUrls(
      workspaceId || dto?.workspaceId || '',
      id,
      dto?.partNumbers,
    );
  }

  @Post(':id/complete')
  async completeSession(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.uploadsService.completeSession(workspaceId, id);
  }

  @Get(':id/download')
  @Redirect(undefined, 307)
  async download(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    return { url: await this.uploadsService.getDownloadUrl(workspaceId, id) };
  }

  @Delete(':id')
  async cancelSession(
    @Param('id') id: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.uploadsService.cancelSession(workspaceId, id);
  }
}
