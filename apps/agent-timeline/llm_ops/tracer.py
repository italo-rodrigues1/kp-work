import time
import uuid
from typing import Dict, Any, List
from config import settings

class LLMTracer:
    """
    LLM Ops Trace Logger: Creates 1 trace per Agent Run and exports to Langfuse.
    """
    def __init__(self):
        self.traces: List[Dict[str, Any]] = []

    def get_langfuse(self):
        if settings.LANGFUSE_ENABLED and settings.LANGFUSE_PUBLIC_KEY and settings.LANGFUSE_SECRET_KEY:
            try:
                from langfuse import get_client
                return get_client()
            except Exception as e:
                print(f"[LangfuseTracer] Unable to get Langfuse client: {e}")
        return None

    def create_trace(
        self,
        run_id: str,
        prompt: str,
        system_prompt: str,
        workspace_id: str,
        thread_id: str = "",
    ) -> Dict[str, Any]:
        trace_id = str(uuid.uuid4())
        trace = {
            "trace_id": trace_id,
            "run_id": run_id,
            "workspace_id": workspace_id,
            "thread_id": thread_id,
            "prompt": prompt,
            "system_prompt": system_prompt,
            "start_time": time.time(),
            "status": "RUNNING",
            "events": []
        }

        client = self.get_langfuse()
        if client:
            try:
                client.create_event(
                    name="START_AGENT_RUN",
                    input={
                        "workspace_id": workspace_id,
                        "thread_id": thread_id,
                        "run_id": run_id,
                        **(
                            {"prompt": prompt, "system_prompt": system_prompt}
                            if settings.LANGFUSE_CAPTURE_CONTENT
                            else {}
                        ),
                    }
                )
            except Exception as e:
                print(f"[LangfuseTracer] Error creating Langfuse trace event: {e}")

        self.traces.append(trace)
        return trace

    def log_event(self, trace: Dict[str, Any], event_name: str, payload: Any):
        trace["events"].append({
            "timestamp": time.time(),
            "event": event_name,
            "payload": payload
        })

        client = self.get_langfuse()
        if client:
            try:
                client.create_event(
                    name=event_name,
                    input={
                        "workspace_id": trace["workspace_id"],
                        "run_id": trace["run_id"],
                        **(
                            {"payload": payload}
                            if settings.LANGFUSE_CAPTURE_CONTENT
                            else {}
                        ),
                    }
                )
            except Exception as e:
                print(f"[LangfuseTracer] Error logging event to Langfuse: {e}")

    def complete_trace(self, trace: Dict[str, Any], reply: str, duration_ms: float) -> Dict[str, Any]:
        trace["end_time"] = time.time()
        trace["reply"] = reply
        trace["duration_ms"] = duration_ms
        trace["status"] = "COMPLETED"

        client = self.get_langfuse()
        if client:
            try:
                client.create_event(
                    name="COMPLETE_AGENT_RUN",
                    output={
                        "workspace_id": trace["workspace_id"],
                        "run_id": trace["run_id"],
                        "duration_ms": duration_ms,
                        **(
                            {"reply": reply}
                            if settings.LANGFUSE_CAPTURE_CONTENT
                            else {}
                        ),
                    }
                )
                client.flush()
            except Exception as e:
                print(f"[LangfuseTracer] Error completing Langfuse trace: {e}")

        return trace
