from typing import Dict, Any
from config import settings

class LLMGate:
    """
    LLM Ops Gate: Evaluates whether the run passed quality thresholds.
    - If passed: Ships Release (new prompt version, model config, tool change, RAG top-k).
    - If not passed: Triggers bug fix / re-trace loop.
    """
    def process_gate(self, eval_result: Dict[str, Any], trace: Dict[str, Any] = None) -> Dict[str, Any]:
        passed = eval_result.get("passed", False)
        
        if passed:
            gate_res = {
                "gate_status": "PASSED",
                "action": "Release",
                "release_info": {
                    "system_prompt_version": "v1.1",
                    "rag_top_k": 3,
                    "status": "Improved System Prompt & Config active"
                }
            }
        else:
            gate_res = {
                "gate_status": "FAILED",
                "action": "Re-trace and Re-eval",
                "fix_instructions": eval_result.get("diagnose", "Investigate prompt or tool parameters.")
            }

        if settings.LANGFUSE_ENABLED and settings.LANGFUSE_PUBLIC_KEY and settings.LANGFUSE_SECRET_KEY:
            try:
                from langfuse import get_client
                client = get_client()
                client.create_event(name="GATE_DECISION", input=eval_result, output=gate_res)
            except Exception as e:
                print(f"[LLMGate] Failed to log gate decision to Langfuse: {e}")

        return gate_res
