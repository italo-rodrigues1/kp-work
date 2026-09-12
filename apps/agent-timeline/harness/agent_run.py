import time
import uuid
from typing import Dict, Any, List, Optional
from config import settings

from harness.memories.procedural import ProceduralMemory
from harness.memories.semantic import SemanticMemory
from harness.memories.episodic import EpisodicMemory
from harness.working_memory import WorkingMemory
from harness.loop import AgentLoop
from harness.guardrails import Guardrails
from harness.summarizer import SummarizerAgent

from llm_ops.tracer import LLMTracer
from llm_ops.observe import LLMObserver
from llm_ops.eval import LLMEvaluator
from llm_ops.gate import LLMGate

try:
    from langfuse import observe
except ImportError:
    def observe(*args, **kwargs):
        def decorator(f):
            return f
        return decorator

def observe_agent_run(function):
    if settings.LANGFUSE_CAPTURE_CONTENT:
        return observe(name="agent_timeline_run", as_type="agent")(function)
    return function

class AIAgentRun:
    """
    AI Agent Run Harness (everything inside the AgentRun box is ephemeral).
    Executes complete cycle per user request according to harness architecture.
    """
    def __init__(self, enable_episodic_database: bool = True):
        self.procedural = ProceduralMemory()
        self.semantic = SemanticMemory()
        self.episodic = EpisodicMemory(
            enable_database=enable_episodic_database,
        )
        
        self.working_memory = WorkingMemory(self.procedural, self.semantic, self.episodic)
        self.agent_loop = AgentLoop()
        self.guardrails = Guardrails()
        self.summarizer = SummarizerAgent()

        self.tracer = LLMTracer()
        self.observer = LLMObserver()
        self.evaluator = LLMEvaluator()
        self.gate = LLMGate()

    @observe_agent_run
    def run(
        self,
        user_prompt: str,
        thread_id: str,
        workspace_id: str = "workspace-default",
        system_prompt: str = "",
        model: str = None,
        persist_messages: bool = True,
        chat_history: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        start_time = time.time()
        run_id = f"run_{uuid.uuid4().hex[:8]}"

        # Step 0: Input Guardrails Check
        valid_input, err_msg = self.guardrails.validate_input(user_prompt)
        if not valid_input:
            return {"status": "BLOCKED", "reply": err_msg}

        # Step 1: Trace Initialization (LLM Ops & Langfuse)
        trace = self.tracer.create_trace(
            run_id=run_id,
            prompt=user_prompt,
            system_prompt=system_prompt,
            workspace_id=workspace_id,
            thread_id=thread_id,
        )
        self.tracer.log_event(trace, "START_WORKING_MEMORY_ASSEMBLY", {"thread_id": thread_id, "model": model})

        # Step 2: Context RAM Assembly in Working Memory
        context_ram = self.working_memory.assemble_context_ram(
            user_prompt=user_prompt,
            thread_id=thread_id,
            workspace_id=workspace_id,
            system_prompt=system_prompt if system_prompt else "You are an AI assistant in an agentic harness.",
            chat_history=chat_history,
        )
        if model:
            context_ram["model"] = model

        self.tracer.log_event(trace, "WORKING_MEMORY_READY", {"facts_count": len(context_ram["semantic_facts"])})

        # Step 3: LLM & Tools Loop
        self.tracer.log_event(trace, "START_AGENT_LOOP", {"model": model})
        loop_output = self.agent_loop.execute_loop(context_ram, model=model)
        raw_reply = loop_output["raw_reply"]
        tool_calls = loop_output["tool_calls"]
        self.tracer.log_event(trace, "END_AGENT_LOOP", {"tools_used": len(tool_calls)})

        # Step 4: End Loop Guardrails -> Reply
        valid_output, reply = self.guardrails.validate_output(raw_reply)
        if not valid_output:
            reply = "I apologize, but I could not generate a safe and valid response."

        # Step 5: Save Message to Episodic Memory when this run owns persistence.
        # RabbitMQ tasks already have the user message stored by the backend and
        # persist the assistant reply through the final stream callback.
        if persist_messages:
            self.episodic.save_message(workspace_id=workspace_id, thread_id=thread_id, sender="user", content=user_prompt)
            self.episodic.save_message(workspace_id=workspace_id, thread_id=thread_id, sender="assistant", content=reply)
            self.tracer.log_event(trace, "MESSAGES_SAVED_TO_EPISODIC", {})
        else:
            self.tracer.log_event(trace, "MESSAGE_PERSISTENCE_DELEGATED", {"owner": "backend"})

        # Step 6: Memory Summarization Check (DB2 Consolidation)
        consolidation = self.summarizer.check_and_consolidate_db2(
            new_messages_count=2,
            thread_messages=context_ram["chat_history"],
            workspace_id=workspace_id,
            thread_id=thread_id,
        )

        duration_ms = (time.time() - start_time) * 1000.0

        # Step 7: LLM Ops (Observe, Eval, Gate, Trace Complete & Langfuse Scoring)
        self.tracer.complete_trace(trace, reply=reply, duration_ms=duration_ms)
        obs = self.observer.observe_run(duration_ms=duration_ms, prompt_len=len(user_prompt), reply_len=len(reply), trace=trace)
        eval_res = self.evaluator.evaluate(prompt=user_prompt, reply=reply, tool_calls_count=len(tool_calls), trace=trace)
        gate_res = self.gate.process_gate(eval_result=eval_res, trace=trace)

        return {
            "run_id": run_id,
            "workspace_id": workspace_id,
            "thread_id": thread_id,
            "reply": reply,
            "tool_calls": tool_calls,
            "working_memory_context": {
                "semantic_facts": context_ram["semantic_facts"],
                "relevant_episodes": context_ram["relevant_episodes"]
            },
            "summarizer_status": consolidation,
            "llm_ops": {
                "trace_id": trace["trace_id"],
                "observation": obs,
                "eval": eval_res,
                "gate": gate_res
            }
        }
