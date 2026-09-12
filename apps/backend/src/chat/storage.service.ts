import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface AgentContextPayload {
  workspaceId: string;
  threadId: string;
  messageId: string;
  userPrompt: string;
  model: string;
  systemPrompt?: string;
  allowedTools: string[];
  chatHistory: Array<{ sender: string; content: string }>;
  createdAt: string;
}

export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface WorkspaceStorageBuckets {
  uploadBucket: string;
  contextBucket: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3Client: S3Client;
  private readonly publicS3Client: S3Client;
  private readonly agentContextBucket =
    process.env.MINIO_AGENT_CONTEXT_BUCKET || 'agent-contexts';
  private readonly chatUploadBucket =
    process.env.MINIO_CHAT_UPLOAD_BUCKET || 'chat-uploads';

  constructor() {
    const minioHost = process.env.MINIO_HOST || 'localhost';
    const minioPort = process.env.MINIO_PORT || '9002';
    const endpoint =
      process.env.MINIO_ENDPOINT || `http://${minioHost}:${minioPort}`;

    const clientOptions = {
      endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || 'chataiapp',
        secretAccessKey:
          process.env.MINIO_SECRET_KEY || 'chat-ai-app-secret-local',
      },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    };

    this.s3Client = new S3Client(clientOptions);
    this.publicS3Client = new S3Client({
      ...clientOptions,
      endpoint: process.env.MINIO_PUBLIC_ENDPOINT || endpoint,
    });
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.assertBucketAccessible(this.agentContextBucket),
      this.assertBucketAccessible(this.chatUploadBucket),
    ]);
  }

  async provisionWorkspaceStorage({
    uploadBucket,
    contextBucket,
  }: WorkspaceStorageBuckets): Promise<void> {
    let contextCreated = false;
    let uploadCreated = false;

    try {
      await this.createBucket(contextBucket);
      contextCreated = true;
      await this.createBucket(uploadBucket);
      uploadCreated = true;
    } catch (error) {
      const cleanup = await Promise.allSettled([
        ...(uploadCreated ? [this.deleteBucket(uploadBucket)] : []),
        ...(contextCreated ? [this.deleteBucket(contextBucket)] : []),
      ]);
      for (const result of cleanup) {
        if (result.status === 'rejected') {
          const message =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          this.logger.warn(
            `Falha ao compensar bucket da workspace: ${message}`,
          );
        }
      }
      throw error;
    }
  }

  async removeWorkspaceStorage({
    uploadBucket,
    contextBucket,
  }: WorkspaceStorageBuckets): Promise<void> {
    const results = await Promise.allSettled([
      this.deleteBucket(uploadBucket),
      this.deleteBucket(contextBucket),
    ]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) {
      throw failed.reason;
    }
  }

  private async assertBucketAccessible(bucketName: string): Promise<void> {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (error) {
      this.logger.error(`MinIO bucket is not accessible: ${bucketName}`);
      throw error;
    }
  }

  async saveAgentContext(
    bucketName: string,
    blobKey: string,
    payload: AgentContextPayload,
  ): Promise<string> {
    const jsonString = JSON.stringify(payload);
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: blobKey,
        Body: jsonString,
        ContentType: 'application/json',
      }),
    );
    this.logger.log(
      `Saved agent context to MinIO blob: ${bucketName}/${blobKey}`,
    );
    return blobKey;
  }

  async getAgentContext(
    bucketName: string,
    blobKey: string,
  ): Promise<AgentContextPayload> {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: blobKey,
      }),
    );
    const bodyContents = await response.Body?.transformToString();
    if (!bodyContents) {
      throw new Error(
        `Blob ${blobKey} empty or not found in bucket ${bucketName}`,
      );
    }
    return JSON.parse(bodyContents) as AgentContextPayload;
  }

  async createUploadUrl(
    bucketName: string,
    objectKey: string,
    contentType: string,
    contentLength: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicS3Client,
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        ContentType: contentType,
        ContentLength: contentLength,
        IfNoneMatch: '*',
      }),
      {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(['content-type']),
      },
    );
  }

  async createMultipartUpload(
    bucketName: string,
    objectKey: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: objectKey,
        ContentType: contentType,
      }),
    );
    if (!response.UploadId) {
      throw new Error('MinIO did not return an upload id.');
    }
    return response.UploadId;
  }

  async createMultipartPartUploadUrl(
    bucketName: string,
    objectKey: string,
    multipartUploadId: string,
    contentType: string,
    partNumber: number,
    contentLength: number,
    expiresInSeconds: number,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: bucketName,
      Key: objectKey,
      UploadId: multipartUploadId,
      PartNumber: partNumber,
      ContentLength: contentLength,
    });
    command.middlewareStack.add(
      (next) => async (args) => {
        const request = args.request as {
          headers?: Record<string, string>;
        };
        if (request.headers) {
          request.headers['content-type'] = contentType;
        }
        return next(args);
      },
      { step: 'build', name: 'signedUploadPartContentType' },
    );
    return getSignedUrl(this.publicS3Client, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(['content-type']),
    });
  }

  isNotFoundError(error: unknown): boolean {
    return this.isNotFound(error);
  }

  async listMultipartParts(
    bucketName: string,
    objectKey: string,
    multipartUploadId: string,
  ): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let partNumberMarker: string | undefined;

    do {
      const response = await this.s3Client.send(
        new ListPartsCommand({
          Bucket: bucketName,
          Key: objectKey,
          UploadId: multipartUploadId,
          PartNumberMarker: partNumberMarker,
          MaxParts: 1000,
        }),
      );

      for (const part of response.Parts || []) {
        if (
          part.PartNumber === undefined ||
          part.Size === undefined ||
          !part.ETag
        ) {
          continue;
        }
        parts.push({
          partNumber: part.PartNumber,
          size: part.Size,
          etag: part.ETag,
        });
      }

      partNumberMarker = response.IsTruncated
        ? response.NextPartNumberMarker
        : undefined;
    } while (partNumberMarker !== undefined);

    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  async completeMultipartUpload(
    bucketName: string,
    objectKey: string,
    multipartUploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: objectKey,
        UploadId: multipartUploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            ETag: part.etag,
            PartNumber: part.partNumber,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(
    bucketName: string,
    objectKey: string,
    multipartUploadId: string,
  ): Promise<void> {
    try {
      await this.s3Client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucketName,
          Key: objectKey,
          UploadId: multipartUploadId,
        }),
      );
    } catch (error) {
      if (!this.isNotFound(error)) {
        throw error;
      }
    }
  }

  async getUploadedObjectMetadata(
    bucketName: string,
    objectKey: string,
  ): Promise<{ size: number | undefined; contentType: string | undefined }> {
    const response = await this.s3Client.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
      }),
    );

    return {
      size: response.ContentLength,
      contentType: response.ContentType,
    };
  }

  async createDownloadUrl(
    bucketName: string,
    objectKey: string,
    fileName: string,
    expiresInSeconds = 300,
  ): Promise<string> {
    const safeFileName = fileName.replace(/["\\\r\n]/g, '_');
    return getSignedUrl(
      this.publicS3Client,
      new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        ResponseContentDisposition: `attachment; filename="${safeFileName}"`,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async deleteUploadedObject(
    bucketName: string,
    objectKey: string,
  ): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
      }),
    );
  }

  private isNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const candidate = error as {
      name?: string;
      Code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    return (
      candidate.$metadata?.httpStatusCode === 404 ||
      candidate.name === 'NoSuchUpload' ||
      candidate.Code === 'NoSuchUpload' ||
      candidate.name === 'NoSuchBucket' ||
      candidate.Code === 'NoSuchBucket'
    );
  }

  private async createBucket(bucketName: string): Promise<void> {
    await this.s3Client.send(
      new CreateBucketCommand({
        Bucket: bucketName,
      }),
    );
  }

  private async deleteBucket(bucketName: string): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteBucketCommand({
          Bucket: bucketName,
        }),
      );
    } catch (error) {
      if (!this.isNotFound(error)) {
        throw error;
      }
    }
  }
}
