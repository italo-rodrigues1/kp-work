from typing import Dict, Any
from config import settings

class LLMObserver:
    """
    LLM Ops Observer: Tracks tokens, latency, and error rates in Langfuse.
    """
    def __init__(self):
        self.total_tokens: int = 0
        self.total_runs: int = 0
        self.error_count: int = 0

    def observe_run(self, duration_ms: float, prompt_len: int, reply_len: int, is_error: bool = False, trace: Dict[str, Any] = None) -> Dict[str, Any]:
        self.total_runs += 1
        estimated_tokens = (prompt_len + reply_len) // 4
        self.total_tokens += estimated_tokens
        
        if is_error:
            self.error_count += 1

        obs_data = {
            "latency_ms": duration_ms,
            "estimated_tokens": estimated_tokens,
            "error_rate": self.error_count / self.total_runs if self.total_runs > 0 else 0.0,
            "healthy": duration_ms < 10000 and not is_error
        }

        if settings.LANGFUSE_ENABLED and settings.LANGFUSE_PUBLIC_KEY and settings.LANGFUSE_SECRET_KEY:
            try:
                from langfuse import get_client
                client = get_client()
                client.score_current_trace(name="latency_ms", value=duration_ms)
                client.score_current_trace(name="estimated_tokens", value=estimated_tokens)
                client.score_current_trace(name="error_rate", value=obs_data["error_rate"])
            except Exception as e:
                print(f"[LLMObserver] Failed to record Langfuse score: {e}")

        return obs_data
