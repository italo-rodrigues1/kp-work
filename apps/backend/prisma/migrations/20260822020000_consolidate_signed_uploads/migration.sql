-- Upload sessions now support both single PUT and multipart uploads.
CREATE TYPE "UploadMode" AS ENUM ('SINGLE', 'MULTIPART');
CREATE TYPE "UploadCategory" AS ENUM ('DOCUMENT', 'MEDIA');
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'COMPLETING', 'COMPLETED', 'ATTACHED', 'DELETING');
CREATE TYPE "StorageDeletionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED');

-- BIGINT is required for media uploads above PostgreSQL's 32-bit INTEGER limit.
ALTER TABLE "Attachment"
  ALTER COLUMN "size" TYPE BIGINT USING "size"::BIGINT;

ALTER TABLE "UploadSession"
  ALTER COLUMN "size" TYPE BIGINT USING "size"::BIGINT,
  ADD COLUMN "mode" "UploadMode" NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN "category" "UploadCategory" NOT NULL DEFAULT 'DOCUMENT',
  ADD COLUMN "multipartUploadId" TEXT,
  ADD COLUMN "partSize" BIGINT,
  ADD COLUMN "partCount" INTEGER;

-- Preserve existing sessions and classify their declared MIME type.
UPDATE "UploadSession"
SET "category" = 'MEDIA'
WHERE LOWER("type") LIKE 'image/%'
   OR LOWER("type") LIKE 'audio/%'
   OR LOWER("type") LIKE 'video/%';

-- Convert the legacy text status without failing on an unexpected old value.
ALTER TABLE "UploadSession" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "UploadSession"
  ALTER COLUMN "status" TYPE "UploadStatus"
  USING (
    CASE
      WHEN "status" IN ('PENDING', 'COMPLETING', 'COMPLETED', 'ATTACHED', 'DELETING')
        THEN "status"
      ELSE 'PENDING'
    END
  )::"UploadStatus";
ALTER TABLE "UploadSession" ALTER COLUMN "status" SET DEFAULT 'PENDING';

CREATE INDEX "UploadSession_status_expiresAt_idx"
  ON "UploadSession"("status", "expiresAt");

-- These records deliberately have no foreign key to Thread or UploadSession:
-- they must survive cascade deletion long enough for the storage worker to run.
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

CREATE UNIQUE INDEX "StorageDeletionTask_bucket_objectKey_key"
  ON "StorageDeletionTask"("bucket", "objectKey");
CREATE INDEX "StorageDeletionTask_status_nextAttemptAt_idx"
  ON "StorageDeletionTask"("status", "nextAttemptAt");
CREATE INDEX "StorageDeletionTask_workspaceId_status_nextAttemptAt_idx"
  ON "StorageDeletionTask"("workspaceId", "status", "nextAttemptAt");
