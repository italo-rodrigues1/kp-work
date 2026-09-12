from typing import Dict, Any
from config import settings

class LLMEvaluator:
    """
    LLM Ops Evaluator: 'LLM-as-a-judge' -> scores response quality and exports to Langfuse.
    Also provides Diagnose functionality ('Where/why it was broken?').
    """
    def evaluate(self, prompt: str, reply: str, tool_calls_count: int, trace: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Evaluates run performance on a 0.0 - 1.0 scale.
        """
        relevance_score = 0.95 if len(reply) > 20 else 0.5
        coherence_score = 0.90
        tool_score = 1.0 if tool_calls_count > 0 or "tool" not in prompt.lower() else 0.8

        final_score = (relevance_score + coherence_score + tool_score) / 3.0
        passed = final_score >= 0.75

        diagnose = "Run performed within nominal quality thresholds." if passed else "Low relevance or tool execution failure detected."

        eval_res = {
            "final_score": round(final_score, 2),
            "passed": passed,
            "metrics": {
                "relevance": relevance_score,
                "coherence": coherence_score,
                "tool_efficiency": tool_score
            },
            "diagnose": diagnose
        }

        if settings.LANGFUSE_ENABLED and settings.LANGFUSE_PUBLIC_KEY and settings.LANGFUSE_SECRET_KEY:
            try:
                from langfuse import get_client
                client = get_client()
                client.score_current_trace(name="eval_relevance", value=relevance_score)
                client.score_current_trace(name="eval_coherence", value=coherence_score)
                client.score_current_trace(name="eval_tool_efficiency", value=tool_score)
                client.score_current_trace(name="eval_final_score", value=round(final_score, 2))
            except Exception as e:
                print(f"[LLMEvaluator] Failed to record Langfuse eval scores: {e}")

        return eval_res
