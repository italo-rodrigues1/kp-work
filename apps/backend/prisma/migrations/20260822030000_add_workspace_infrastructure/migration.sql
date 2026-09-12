-- The existing catalog database remains the physical database for the default
-- workspace. Newly-created workspaces receive their own PostgreSQL database.
ALTER TABLE "Workspace"
  ADD COLUMN "databaseName" TEXT,
  ADD COLUMN "uploadBucket" TEXT,
  ADD COLUMN "contextBucket" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PROVISIONING',
  ADD COLUMN "provisioningError" TEXT;

UPDATE "Workspace"
SET
  "databaseName" = current_database(),
  "uploadBucket" = 'chat-uploads',
  "contextBucket" = 'agent-contexts',
  "status" = 'READY'
WHERE "id" = 'workspace-default';

-- Preserve metadata for installations that created other workspaces before
-- physical isolation existed, but quarantine them until an operator migrates
-- their catalog content into dedicated databases and buckets.
UPDATE "Workspace"
SET
  "databaseName" = current_database() || '_legacy_' || substr(md5("id"), 1, 12),
  "uploadBucket" = 'chat-uploads-legacy-' || substr(md5("id"), 1, 12),
  "contextBucket" = 'agent-contexts-legacy-' || substr(md5("id"), 1, 12),
  "status" = 'FAILED',
  "provisioningError" = 'Workspace criado antes do provisionamento de banco dedicado; requer migração administrativa.'
WHERE "databaseName" IS NULL;

ALTER TABLE "Workspace"
  ALTER COLUMN "databaseName" SET NOT NULL,
  ALTER COLUMN "uploadBucket" SET NOT NULL,
  ALTER COLUMN "contextBucket" SET NOT NULL;

CREATE UNIQUE INDEX "Workspace_databaseName_key" ON "Workspace"("databaseName");
CREATE UNIQUE INDEX "Workspace_uploadBucket_key" ON "Workspace"("uploadBucket");
CREATE UNIQUE INDEX "Workspace_contextBucket_key" ON "Workspace"("contextBucket");
CREATE INDEX "Workspace_status_createdAt_idx" ON "Workspace"("status", "createdAt");

ALTER TABLE "Workspace"
  ADD CONSTRAINT "Workspace_status_check"
  CHECK ("status" IN ('PROVISIONING', 'READY', 'FAILED'));

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

CREATE INDEX "Agent_workspaceId_createdAt_idx"
  ON "Agent"("workspaceId", "createdAt");

ALTER TABLE "Agent"
  ADD CONSTRAINT "Agent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
