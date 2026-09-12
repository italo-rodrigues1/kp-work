import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

class Settings:
    APP_NAME: str = "Agent Timeline Service"
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")
    PORT: int = int(os.getenv("PORT", "8000"))
    
    # LLM Settings
    OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY", "")
    OPENROUTER_BASE_URL: str = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    DEFAULT_MODEL: str = os.getenv("DEFAULT_MODEL", "openai/gpt-4o")
    CHEAPER_MODEL: str = os.getenv("CHEAPER_MODEL", "openai/gpt-4o-mini")
    
    # Storage & DB Connections
    DATABASE_URL: str = os.getenv("DATABASE_URL", "postgresql://postgres:postgrespassword@localhost:5433/chat_ai")
    QDRANT_HOST: str = os.getenv("QDRANT_HOST", "localhost")
    QDRANT_PORT: int = int(os.getenv("QDRANT_PORT", "6333"))
    
    # MinIO Blob Storage
    MINIO_ENDPOINT: str = os.getenv("MINIO_ENDPOINT", "localhost:9002")
    MINIO_ACCESS_KEY: str = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
    MINIO_SECRET_KEY: str = os.getenv("MINIO_SECRET_KEY", "minioadminpassword")
    MINIO_SECURE: bool = os.getenv("MINIO_SECURE", "false").lower() == "true"
    MINIO_AGENT_CONTEXT_BUCKET: str = os.getenv(
        "MINIO_AGENT_CONTEXT_BUCKET",
        "agent-contexts",
    )

    # Backend callback is service-owned configuration. RabbitMQ messages must
    # never be allowed to redirect the worker to an arbitrary URL.
    BACKEND_CALLBACK_URL: str = os.getenv(
        "BACKEND_CALLBACK_URL",
        "http://localhost:3001/api/chat/stream-chunk",
    )
    AGENT_CALLBACK_TOKEN: str = os.getenv(
        "AGENT_CALLBACK_TOKEN",
        "" if ENVIRONMENT == "production" else "chat-ai-agent-callback-local",
    )
    
    # RabbitMQ Message Broker
    RABBITMQ_HOST: str = os.getenv("RABBITMQ_HOST", "localhost")
    RABBITMQ_PORT: int = int(os.getenv("RABBITMQ_PORT", "5672"))
    RABBITMQ_USER: str = os.getenv("RABBITMQ_USER", "rabbitmq")
    RABBITMQ_PASS: str = os.getenv("RABBITMQ_PASS", "rabbitmqpassword")
    RABBITMQ_QUEUE: str = os.getenv("RABBITMQ_QUEUE", "agent_tasks")
    
    # Summarization Thresholds
    CONSOLIDATION_CHAT_COUNT: int = int(os.getenv("CONSOLIDATION_CHAT_COUNT", "5"))

    # Langfuse Observability & Tracing
    LANGFUSE_PUBLIC_KEY: str = os.getenv("LANGFUSE_PUBLIC_KEY", "")
    LANGFUSE_SECRET_KEY: str = os.getenv("LANGFUSE_SECRET_KEY", "")
    LANGFUSE_HOST: str = os.getenv("LANGFUSE_HOST", "http://localhost:3000")
    LANGFUSE_ENABLED: bool = os.getenv("LANGFUSE_ENABLED", "true").lower() == "true"
    # Conteúdo de prompts/respostas só pode sair do limite da workspace por
    # opt-in explícito. Métricas e identificadores continuam disponíveis.
    LANGFUSE_CAPTURE_CONTENT: bool = os.getenv(
        "LANGFUSE_CAPTURE_CONTENT",
        "false",
    ).lower() == "true"

    def sync_env(self):
        if self.LANGFUSE_PUBLIC_KEY:
            os.environ["LANGFUSE_PUBLIC_KEY"] = self.LANGFUSE_PUBLIC_KEY
        if self.LANGFUSE_SECRET_KEY:
            os.environ["LANGFUSE_SECRET_KEY"] = self.LANGFUSE_SECRET_KEY
        if self.LANGFUSE_HOST:
            os.environ["LANGFUSE_HOST"] = self.LANGFUSE_HOST

settings = Settings()
settings.sync_env()
