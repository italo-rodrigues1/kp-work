-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#f97316',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- Preserve existing content in a default workspace.
INSERT INTO "Workspace" ("id", "name", "color", "createdAt", "updatedAt")
VALUES ('workspace-default', 'Pessoal', '#f97316', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- AddColumn
ALTER TABLE "Thread" ADD COLUMN "workspaceId" TEXT;

UPDATE "Thread"
SET "workspaceId" = 'workspace-default'
WHERE "workspaceId" IS NULL;

ALTER TABLE "Thread" ALTER COLUMN "workspaceId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Thread_workspaceId_updatedAt_idx" ON "Thread"("workspaceId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Scope persisted events to the workspace that produced them.
ALTER TABLE "ChatEvent" ADD COLUMN "workspaceId" TEXT;

UPDATE "ChatEvent" AS event
SET "workspaceId" = thread."workspaceId"
FROM "Thread" AS thread
WHERE event."threadId" = thread."id";

UPDATE "ChatEvent"
SET "workspaceId" = 'workspace-default'
WHERE "workspaceId" IS NULL;

CREATE INDEX "ChatEvent_workspaceId_createdAt_idx" ON "ChatEvent"("workspaceId", "createdAt");

ALTER TABLE "ChatEvent" ADD CONSTRAINT "ChatEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
