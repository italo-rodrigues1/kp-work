from typing import Dict, Any, List
from config import settings

class SummarizerAgent:
    """
    Summarizer Agent running cheaper models (e.g. gpt-4o-mini).
    1. Distills DB1 (Procedural/Semantic raw data) into durable facts.
    2. Consolidates DB2 (Episodic chat memory) after N new chats into facts/summaries.
    """
    def __init__(self, model_name: str = settings.CHEAPER_MODEL):
        self.model_name = model_name
        self.chat_counters: Dict[str, Dict[str, int]] = {}
        self.consolidation_threshold = settings.CONSOLIDATION_CHAT_COUNT

    def distill_facts_from_db1(self, raw_procedural_data: List[Dict[str, Any]]) -> List[str]:
        """
        Distills raw procedural/semantic files into key structured facts.
        """
        distilled_facts = []
        for item in raw_procedural_data:
            content = item.get("content", "")
            distilled_facts.append(f"Distilled Fact: Procedural rules active ({len(content)} chars context).")
        return distilled_facts

    def check_and_consolidate_db2(
        self,
        new_messages_count: int,
        thread_messages: List[Dict[str, Any]],
        workspace_id: str = "workspace-default",
        thread_id: str = "default_thread",
    ) -> Dict[str, Any]:
        """
        Only consolidates DB2 episodic chat memory after N new chats.
        Counters are isolated by workspace and thread so activity in one
        conversation cannot trigger consolidation in another.
        """
        workspace_counters = self.chat_counters.setdefault(workspace_id, {})
        chat_counter = workspace_counters.get(thread_id, 0) + new_messages_count

        if chat_counter >= self.consolidation_threshold:
            summary = f"Consolidated Summary of last {chat_counter} messages: Thread discussed user requirements, agent tools, and system harness timeline."
            workspace_counters.pop(thread_id, None)
            if not workspace_counters:
                self.chat_counters.pop(workspace_id, None)
            return {
                "consolidated": True,
                "summary": summary,
                "model_used": self.model_name
            }

        workspace_counters[thread_id] = chat_counter
        return {
            "consolidated": False,
            "messages_pending": chat_counter,
            "threshold": self.consolidation_threshold
        }
