/**
 * Physical workspace databases are intentionally bootstrapped from a versioned
 * SQL document. Increment this version whenever the tenant schema changes and
 * add an upgrade path before provisioning workspaces with the newer schema.
 */
export const WORKSPACE_SCHEMA_VERSION = 1;

export const WORKSPACE_BOOTSTRAP_SQL = `
CREATE TYPE "UploadMode" AS ENUM ('SINGLE', 'MULTIPART');
CREATE TYPE "UploadCategory" AS ENUM ('DOCUMENT', 'MEDIA');
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'COMPLETING', 'COMPLETED', 'ATTACHED', 'DELETING');
CREATE TYPE "StorageDeletionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED');

CREATE TABLE "WorkspaceSchemaVersion" (
  "version" INTEGER NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkspaceSchemaVersion_pkey" PRIMARY KEY ("version")
);

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT,
  "name" TEXT NOT NULL DEFAULT 'Usuário',
  "avatarUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Workspace" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#f97316',
  "databaseName" TEXT NOT NULL,
  "uploadBucket" TEXT NOT NULL,
  "contextBucket" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROVISIONING',
  "provisioningError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Workspace_status_check" CHECK ("status" IN ('PROVISIONING', 'READY', 'FAILED'))
);

CREATE TABLE "Agent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "instructions" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "tools" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Thread" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT 'Nova Conversa',
  "model" TEXT NOT NULL DEFAULT 'gpt-4o',
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "sender" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "model" TEXT,
  "isStreaming" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Attachment" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "size" BIGINT NOT NULL,
  "type" TEXT NOT NULL,
  "url" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AudioAttachment" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "durationSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AudioAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UploadSession" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "messageId" TEXT,
  "objectKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "size" BIGINT NOT NULL,
  "type" TEXT NOT NULL,
  "mode" "UploadMode" NOT NULL DEFAULT 'SINGLE',
  "category" "UploadCategory" NOT NULL DEFAULT 'DOCUMENT',
  "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
  "multipartUploadId" TEXT,
  "partSize" BIGINT,
  "partCount" INTEGER,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "attachedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorageDeletionTask" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "multipartUploadId" TEXT,
  "status" "StorageDeletionStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorageDeletionTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatEvent" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT,
  "message" TEXT NOT NULL,
  "workspaceId" TEXT,
  "threadId" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Workspace_databaseName_key" ON "Workspace"("databaseName");
CREATE UNIQUE INDEX "Workspace_uploadBucket_key" ON "Workspace"("uploadBucket");
CREATE UNIQUE INDEX "Workspace_contextBucket_key" ON "Workspace"("contextBucket");
CREATE INDEX "Workspace_status_createdAt_idx" ON "Workspace"("status", "createdAt");
CREATE INDEX "Agent_workspaceId_createdAt_idx" ON "Agent"("workspaceId", "createdAt");
CREATE INDEX "Thread_workspaceId_updatedAt_idx" ON "Thread"("workspaceId", "updatedAt");
CREATE UNIQUE INDEX "AudioAttachment_messageId_key" ON "AudioAttachment"("messageId");
CREATE UNIQUE INDEX "UploadSession_objectKey_key" ON "UploadSession"("objectKey");
CREATE INDEX "UploadSession_threadId_status_idx" ON "UploadSession"("threadId", "status");
CREATE INDEX "UploadSession_status_expiresAt_idx" ON "UploadSession"("status", "expiresAt");
CREATE INDEX "UploadSession_messageId_idx" ON "UploadSession"("messageId");
CREATE UNIQUE INDEX "StorageDeletionTask_bucket_objectKey_key" ON "StorageDeletionTask"("bucket", "objectKey");
CREATE INDEX "StorageDeletionTask_status_nextAttemptAt_idx" ON "StorageDeletionTask"("status", "nextAttemptAt");
CREATE INDEX "StorageDeletionTask_workspaceId_status_nextAttemptAt_idx" ON "StorageDeletionTask"("workspaceId", "status", "nextAttemptAt");
CREATE INDEX "ChatEvent_workspaceId_createdAt_idx" ON "ChatEvent"("workspaceId", "createdAt");

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudioAttachment" ADD CONSTRAINT "AudioAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatEvent" ADD CONSTRAINT "ChatEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatEvent" ADD CONSTRAINT "ChatEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
`;
