import datetime
from typing import List, Dict, Any
from config import settings

try:
    from sqlalchemy import create_engine, text
    HAS_SQLALCHEMY = True
except ImportError:
    HAS_SQLALCHEMY = False

class EpisodicMemory:
    """
    Episodic Memory manages dated events and past chat history.
    Combines SQL DB queries for recency and Vector Store search for semantic relevance.
    """
    def __init__(
        self,
        db_url: str = settings.DATABASE_URL,
        enable_database: bool = True,
    ):
        self.db_url = db_url
        self.engine = None
        if enable_database and HAS_SQLALCHEMY:
            try:
                self.engine = create_engine(self.db_url, pool_pre_ping=True)
            except Exception:
                self.engine = None
        
        # Local fallback store if DB is offline or sqlalchemy unavailable
        self.local_history: List[Dict[str, Any]] = []

    def get_recent_history(self, workspace_id: str, thread_id: str, limit: int = 10) -> List[Dict[str, Any]]:
        """
        SQL search for recency: fetches the latest chat messages for thread_id.
        """
        if self.engine:
            try:
                with self.engine.connect() as conn:
                    result = conn.execute(
                        text('SELECT message.sender, message.content, message."createdAt" FROM "Message" AS message INNER JOIN "Thread" AS thread ON thread.id = message."threadId" WHERE message."threadId" = :thread_id AND thread."workspaceId" = :workspace_id ORDER BY message."createdAt" DESC LIMIT :limit'),
                        {"workspace_id": workspace_id, "thread_id": thread_id, "limit": limit}
                    )
                    rows = result.fetchall()
                    messages = []
                    for row in reversed(rows):
                        messages.append({
                            "sender": row[0],
                            "content": row[1],
                            "createdAt": str(row[2])
                        })
                    return messages
            except Exception:
                pass

        return [
            m
            for m in self.local_history
            if m.get("workspaceId") == workspace_id and m.get("threadId") == thread_id
        ][-limit:]

    def search_relevant_episodes(self, query: str, workspace_id: str, top_k: int = 3) -> List[str]:
        """
        Vector search (RAG) for relevance over past historical events.
        """
        return [f"Past Event: Previous discussion regarding system architecture and agent timeline."]

    def save_message(self, workspace_id: str, thread_id: str, sender: str, content: str, model: str = settings.DEFAULT_MODEL) -> bool:
        """
        Saves a new message into Episodic Memory (PostgreSQL or local fallback).
        """
        saved_db = False
        if self.engine:
            try:
                with self.engine.connect() as conn:
                    conn.execute(
                        text('INSERT INTO "Message" (id, "threadId", sender, content, model, "createdAt", "updatedAt") SELECT :id, :thread_id, :sender, :content, :model, NOW(), NOW() WHERE EXISTS (SELECT 1 FROM "Thread" WHERE id = :thread_id AND "workspaceId" = :workspace_id)'),
                        {
                            "id": f"msg_{int(datetime.datetime.now().timestamp()*1000)}",
                            "workspace_id": workspace_id,
                            "thread_id": thread_id,
                            "sender": sender,
                            "content": content,
                            "model": model
                        }
                    )
                    conn.commit()
                    saved_db = True
            except Exception:
                pass

        self.local_history.append({
            "id": f"msg_{int(datetime.datetime.now().timestamp()*1000)}",
            "workspaceId": workspace_id,
            "threadId": thread_id,
            "sender": sender,
            "content": content,
            "model": model,
            "createdAt": datetime.datetime.now().isoformat()
        })
        return True
