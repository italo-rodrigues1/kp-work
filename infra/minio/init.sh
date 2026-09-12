#!/bin/sh
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc ready local

mc mb --ignore-existing local/agent-contexts
mc mb --ignore-existing local/chat-uploads

if ! mc admin user info local "$MINIO_ACCESS_KEY" >/dev/null 2>&1; then
  mc admin user add local "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
fi

mc admin policy create local chat-ai-backend /config/backend-policy.json
mc admin policy attach local chat-ai-backend --user "$MINIO_ACCESS_KEY"
