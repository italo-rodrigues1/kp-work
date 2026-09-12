import json
import re
import time
import threading
import httpx
import pika
from minio import Minio

from config import settings
from harness.agent_run import AIAgentRun

class AgentWorker:
    def __init__(self):
        # Initialize MinIO S3 Client
        self.minio_client = Minio(
            settings.MINIO_ENDPOINT,
            access_key=settings.MINIO_ACCESS_KEY,
            secret_key=settings.MINIO_SECRET_KEY,
            secure=settings.MINIO_SECURE
        )
        self._running = False
        self._thread = None

        if not settings.BACKEND_CALLBACK_URL.strip():
            raise ValueError("BACKEND_CALLBACK_URL must not be empty")
        if not settings.AGENT_CALLBACK_TOKEN.strip():
            raise ValueError("AGENT_CALLBACK_TOKEN must not be empty")

    @staticmethod
    def expected_context_bucket(workspace_id: str) -> str:
        if workspace_id == "workspace-default":
            return settings.MINIO_AGENT_CONTEXT_BUCKET

        token = workspace_id.replace("-", "").lower()
        if not re.fullmatch(r"[0-9a-f]{32}", token):
            raise ValueError(
                "Non-default workspaceId must be a UUID for deterministic "
                "MinIO isolation"
            )
        return f"chat-ai-ws-{token}-contexts"

    def fetch_agent_context(self, bucket: str, blob_key: str) -> dict:
        response = None
        try:
            response = self.minio_client.get_object(bucket, blob_key)
            data = response.read().decode('utf-8')
            return json.loads(data)
        except Exception as e:
            print(f"[Worker] Error fetching blob {blob_key} from MinIO bucket {bucket}: {str(e)}")
            raise
        finally:
            if response is not None:
                response.close()
                response.release_conn()

    def stream_chunk_to_backend(self, payload: dict):
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.post(
                    settings.BACKEND_CALLBACK_URL,
                    json=payload,
                    headers={
                        "x-agent-callback-token": settings.AGENT_CALLBACK_TOKEN,
                    },
                )
                response.raise_for_status()
        except Exception as e:
            print(
                "[Worker] Error posting stream chunk to configured backend "
                f"callback {settings.BACKEND_CALLBACK_URL}: {str(e)}"
            )
            raise

    @staticmethod
    def _required_identifier(payload: dict, field: str, source: str) -> str:
        value = payload.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Missing or invalid {field} in {source}")
        return value

    def validate_task_context_identity(self, task: dict, context: dict):
        identity_fields = (
            ("workspaceId", "workspaceId"),
            ("threadId", "threadId"),
            ("userMessageId", "messageId"),
        )

        validated = {}
        for task_field, context_field in identity_fields:
            task_value = self._required_identifier(task, task_field, "RabbitMQ task")
            context_value = self._required_identifier(context, context_field, "agent context blob")
            if task_value != context_value:
                raise ValueError(
                    f"Task/blob identity mismatch for {task_field}: "
                    f"task={task_value!r}, blob={context_value!r}"
                )
            validated[task_field] = task_value

        return validated

    @staticmethod
    def validate_chat_history(context: dict) -> list[dict]:
        raw_history = context.get("chatHistory")
        if not isinstance(raw_history, list):
            raise ValueError("Missing or invalid chatHistory in agent context blob")

        chat_history = []
        for index, message in enumerate(raw_history):
            if not isinstance(message, dict):
                raise ValueError(f"Invalid chatHistory entry at index {index}")
            sender = message.get("sender")
            content = message.get("content")
            if not isinstance(sender, str) or not isinstance(content, str):
                raise ValueError(f"Invalid chatHistory entry at index {index}")
            chat_history.append({"sender": sender, "content": content})
        return chat_history

    def process_task(self, body_bytes: bytes):
        try:
            task = json.loads(body_bytes.decode('utf-8'))
            workspace_id = self._required_identifier(
                task,
                "workspaceId",
                "RabbitMQ task",
            )
            blob_bucket = task.get("blobBucket")
            if blob_bucket is None and workspace_id == "workspace-default":
                blob_bucket = settings.MINIO_AGENT_CONTEXT_BUCKET
            blob_key = task.get("blobKey")

            if not isinstance(blob_bucket, str) or not blob_bucket.strip():
                raise ValueError("Missing or invalid blobBucket in RabbitMQ task")
            expected_bucket = self.expected_context_bucket(workspace_id)
            if blob_bucket != expected_bucket:
                raise ValueError(
                    "Unexpected context bucket for workspace: "
                    f"expected={expected_bucket!r}, received={blob_bucket!r}"
                )
            if not isinstance(blob_key, str) or not blob_key.strip():
                raise ValueError("Missing or invalid blobKey in RabbitMQ task")
            if not blob_key.startswith("agent-context/"):
                raise ValueError(
                    "Agent context blobKey must start with 'agent-context/'"
                )

            print(f"[Worker] Received task, fetching blob [{blob_key}]...")

            # 1. Pull context JSON from MinIO Blob Storage
            context = self.fetch_agent_context(blob_bucket, blob_key)
            identity = self.validate_task_context_identity(task, context)
            thread_id = identity["threadId"]
            user_message_id = identity["userMessageId"]
            user_prompt = self._required_identifier(
                context,
                "userPrompt",
                "agent context blob",
            )
            system_prompt = context.get("systemPrompt", "")
            model = context.get("model", settings.DEFAULT_MODEL)
            chat_history = self.validate_chat_history(context)

            # 2. Run AI Agent Harness
            # A fresh harness per task prevents local fallback memory from being
            # reused across workspace executions.
            agent_harness = AIAgentRun(enable_episodic_database=False)
            result = agent_harness.run(
                user_prompt=user_prompt,
                thread_id=thread_id,
                workspace_id=workspace_id,
                system_prompt=system_prompt,
                model=model,
                persist_messages=False,
                chat_history=chat_history,
            )

            reply = result.get("reply", "")
            tool_calls = result.get("tool_calls", [])
            working_mem = result.get("working_memory_context", {})

            # 3. Simulate real-time word-by-word streaming HTTP callback to Backend
            words = reply.split(' ')
            accumulated = ""
            for i, word in enumerate(words):
                chunk = word + (" " if i < len(words) - 1 else "")
                accumulated += chunk
                
                self.stream_chunk_to_backend({
                    "workspaceId": workspace_id,
                    "threadId": thread_id,
                    "userMessageId": user_message_id,
                    "chunk": chunk,
                    "accumulated": accumulated,
                    "isDone": False,
                    "model": model,
                })
                time.sleep(0.04)  # Smooth real-time token streaming effect

            # 4. Final completion stream chunk
            self.stream_chunk_to_backend({
                "workspaceId": workspace_id,
                "threadId": thread_id,
                "userMessageId": user_message_id,
                "chunk": "",
                "accumulated": reply,
                "isDone": True,
                "model": model,
                "toolCalls": tool_calls,
                "workingMemoryContext": working_mem,
            })

            print(f"[Worker] Successfully processed task for thread [{thread_id}] and streamed response.")

        except Exception as e:
            print(f"[Worker] Task execution failed: {str(e)}")
            raise

    def _rabbitmq_consumer_loop(self):
        credentials = pika.PlainCredentials(settings.RABBITMQ_USER, settings.RABBITMQ_PASS)
        parameters = pika.ConnectionParameters(
            host=settings.RABBITMQ_HOST,
            port=settings.RABBITMQ_PORT,
            credentials=credentials,
            heartbeat=60,
            blocked_connection_timeout=300
        )

        while self._running:
            try:
                print(f"[Worker] Connecting to RabbitMQ at {settings.RABBITMQ_HOST}:{settings.RABBITMQ_PORT}...")
                connection = pika.BlockingConnection(parameters)
                channel = connection.channel()
                channel.queue_declare(queue=settings.RABBITMQ_QUEUE, durable=True)
                channel.basic_qos(prefetch_count=1)

                print(f"[Worker] Listening for agent tasks on RabbitMQ queue [{settings.RABBITMQ_QUEUE}]...")

                def callback(ch, method, properties, body):
                    try:
                        self.process_task(body)
                    except Exception as exc:
                        if method.redelivered:
                            print(
                                "[Worker] Task failed after one retry; rejecting "
                                f"without requeue: {str(exc)}"
                            )
                            ch.basic_nack(
                                delivery_tag=method.delivery_tag,
                                requeue=False,
                            )
                        else:
                            print(
                                "[Worker] Task failed; scheduling one RabbitMQ "
                                f"redelivery: {str(exc)}"
                            )
                            ch.basic_nack(
                                delivery_tag=method.delivery_tag,
                                requeue=True,
                            )
                        return

                    ch.basic_ack(delivery_tag=method.delivery_tag)

                channel.basic_consume(queue=settings.RABBITMQ_QUEUE, on_message_callback=callback)
                channel.start_consuming()

            except Exception as e:
                print(f"[Worker] RabbitMQ connection lost/failed ({str(e)}). Retrying in 5 seconds...")
                time.sleep(5)

    def start(self):
        if not self._running:
            self._running = True
            self._thread = threading.Thread(target=self._rabbitmq_consumer_loop, daemon=True)
            self._thread.start()
            print("[Worker] Agent worker background thread started.")

    def stop(self):
        self._running = False
        print("[Worker] Agent worker stopped.")
