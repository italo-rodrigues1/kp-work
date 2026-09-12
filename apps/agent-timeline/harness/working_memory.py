from typing import List, Dict, Any, Optional
from harness.memories.procedural import ProceduralMemory
from harness.memories.semantic import SemanticMemory
from harness.memories.episodic import EpisodicMemory

class WorkingMemory:
    """
    Working Memory / Context RAM (Ephemeral for AI Agent Run).
    Aggregates User Prompt, Chat History, System Prompt, and retrievals from
    Procedural, Semantic, and Episodic memories.
    """
    def __init__(
        self,
        procedural: ProceduralMemory,
        semantic: SemanticMemory,
        episodic: EpisodicMemory
    ):
        self.procedural = procedural
        self.semantic = semantic
        self.episodic = episodic

    def assemble_context_ram(
        self,
        user_prompt: str,
        thread_id: str,
        workspace_id: str,
        system_prompt: str = "You are an advanced AI Agent operating in an autonomous harness.",
        chat_history: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Builds the Working Memory Context RAM payload.
        """
        # 1. Procedural Memory instructions
        skill_instructions = self.procedural.get_skill_instructions()

        # 2. Semantic Memory RAG search
        semantic_facts = self.semantic.query_facts(
            query_text=user_prompt,
            workspace_id=workspace_id,
            top_k=3,
        )

        # 3. Episodic Memory: Recency (SQL) + Relevance (Vector RAG)
        if chat_history is None:
            resolved_chat_history = self.episodic.get_recent_history(
                workspace_id=workspace_id,
                thread_id=thread_id,
                limit=10,
            )
        else:
            # The RabbitMQ worker receives an authoritative, workspace-scoped
            # history snapshot in the MinIO context blob. Copy it so the
            # ephemeral harness cannot mutate the caller's payload.
            resolved_chat_history = [dict(message) for message in chat_history]
        relevant_episodes = self.episodic.search_relevant_episodes(
            query=user_prompt,
            workspace_id=workspace_id,
            top_k=2,
        )

        # Build merged system context prompt
        merged_system_prompt = (
            f"{system_prompt}\n\n"
            f"=== PROCEDURAL INSTRUCTIONS ===\n{skill_instructions}\n\n"
            f"=== SEMANTIC MEMORY (FACTS) ===\n" + "\n".join(f"- {f}" for f in semantic_facts) + "\n\n"
            f"=== EPISODIC MEMORY (RELEVANT CONTEXT) ===\n" + "\n".join(f"- {e}" for e in relevant_episodes)
        )

        return {
            "user_prompt": user_prompt,
            "workspace_id": workspace_id,
            "thread_id": thread_id,
            "system_prompt": merged_system_prompt,
            "chat_history": resolved_chat_history,
            "semantic_facts": semantic_facts,
            "relevant_episodes": relevant_episodes
        }
