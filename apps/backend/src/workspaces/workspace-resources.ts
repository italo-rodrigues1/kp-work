import { randomUUID } from 'node:crypto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_NAME_PATTERN = /^chat_ai_ws_[0-9a-f]{32}$/;
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export interface WorkspaceResourceNames {
  id: string;
  databaseName: string;
  uploadBucket: string;
  contextBucket: string;
}

export function newWorkspaceResourceNames(): WorkspaceResourceNames {
  return workspaceResourceNames(randomUUID());
}

export function workspaceResourceNames(
  workspaceId: string,
): WorkspaceResourceNames {
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new Error('Workspace resource names require a valid UUID.');
  }

  const token = workspaceId.replaceAll('-', '').toLowerCase();
  const names = {
    id: workspaceId,
    databaseName: `chat_ai_ws_${token}`,
    uploadBucket: `chat-ai-ws-${token}-uploads`,
    contextBucket: `chat-ai-ws-${token}-contexts`,
  };

  assertDatabaseName(names.databaseName);
  assertBucketName(names.uploadBucket);
  assertBucketName(names.contextBucket);

  return names;
}

export function assertDatabaseName(databaseName: string): void {
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error(`Invalid managed workspace database name: ${databaseName}`);
  }
}

export function assertBucketName(bucketName: string): void {
  if (!BUCKET_NAME_PATTERN.test(bucketName)) {
    throw new Error(`Invalid managed workspace bucket name: ${bucketName}`);
  }
}
