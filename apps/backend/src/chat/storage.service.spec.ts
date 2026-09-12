/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

describe('StorageService workspace isolation', () => {
  const uploadBucket = 'chat-ai-ws-123e4567e89b42d3a456426614174000-uploads';
  const contextBucket = 'chat-ai-ws-123e4567e89b42d3a456426614174000-contexts';
  let service: StorageService;
  let send: jest.Mock;

  beforeEach(() => {
    service = new StorageService();
    send = jest.fn().mockResolvedValue({});
    Object.defineProperty(service, 's3Client', {
      value: { send },
    });
    Object.defineProperty(service, 'publicS3Client', {
      value: {},
    });
    jest.mocked(getSignedUrl).mockResolvedValue('https://minio.test/upload');
  });

  it('uses the explicit context bucket when saving a blob', async () => {
    await service.saveAgentContext(contextBucket, 'agent-context/task.json', {
      workspaceId: '123e4567-e89b-42d3-a456-426614174000',
      threadId: 'thread-1',
      messageId: 'message-1',
      userPrompt: 'Olá',
      model: 'openai/gpt-4o',
      allowedTools: [],
      chatHistory: [],
      createdAt: new Date(0).toISOString(),
    });

    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe(contextBucket);
    expect(command.input.Key).toBe('agent-context/task.json');
  });

  it('creates both workspace buckets without bucket-level CORS', async () => {
    await service.provisionWorkspaceStorage({
      uploadBucket,
      contextBucket,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(CreateBucketCommand);
    expect(send.mock.calls[0][0].input.Bucket).toBe(contextBucket);
    expect(send.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
    expect(send.mock.calls[1][0].input.Bucket).toBe(uploadBucket);
  });

  it('propagates workspace provisioning failures', async () => {
    const failure = new Error('upload bucket failed');
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(failure);

    await expect(
      service.provisionWorkspaceStorage({ uploadBucket, contextBucket }),
    ).rejects.toBe(failure);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteBucketCommand);
  });

  it('compensa somente os buckets que esta tentativa chegou a criar', async () => {
    const failure = new Error('upload bucket already exists');
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({});

    await expect(
      service.provisionWorkspaceStorage({ uploadBucket, contextBucket }),
    ).rejects.toBe(failure);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toBeInstanceOf(CreateBucketCommand);
    expect(send.mock.calls[0][0].input.Bucket).toBe(contextBucket);
    expect(send.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
    expect(send.mock.calls[1][0].input.Bucket).toBe(uploadBucket);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteBucketCommand);
    expect(send.mock.calls[2][0].input.Bucket).toBe(contextBucket);
  });

  it('não remove um bucket preexistente quando a primeira criação falha', async () => {
    const failure = new Error('context bucket already exists');
    send.mockRejectedValueOnce(failure);

    await expect(
      service.provisionWorkspaceStorage({ uploadBucket, contextBucket }),
    ).rejects.toBe(failure);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(CreateBucketCommand);
    expect(send.mock.calls[0][0].input.Bucket).toBe(contextBucket);
  });

  it('attempts to remove both buckets during compensation', async () => {
    await service.removeWorkspaceStorage({ uploadBucket, contextBucket });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteBucketCommand);
    expect(send.mock.calls[0][0].input.Bucket).toBe(uploadBucket);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteBucketCommand);
    expect(send.mock.calls[1][0].input.Bucket).toBe(contextBucket);
  });

  it('signs uploads against the explicit bucket and declared size', async () => {
    await service.createUploadUrl(
      uploadBucket,
      'uploads/file.bin',
      'application/octet-stream',
      42,
      900,
    );

    const command = jest.mocked(getSignedUrl).mock
      .calls[0][1] as PutObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: uploadBucket,
      Key: 'uploads/file.bin',
      ContentType: 'application/octet-stream',
      ContentLength: 42,
      IfNoneMatch: '*',
    });
    expect(jest.mocked(getSignedUrl).mock.calls[0][2]).toEqual(
      expect.objectContaining({
        expiresIn: 900,
        signableHeaders: new Set(['content-type']),
      }),
    );
  });
});
