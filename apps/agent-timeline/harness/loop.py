from typing import Dict, Any, List
from harness.tools import get_available_tools
from config import settings

class AgentLoop:
    """
    Loop subgraph: Manages LLM Q&A Agent execution and Tool Calls cycle.
    """
    def __init__(self, model_name: str = settings.DEFAULT_MODEL):
        self.model_name = model_name
        self.tools = get_available_tools()
        self.tool_map = {t.name: t for t in self.tools}

    def execute_loop(self, context_ram: Dict[str, Any], model: str = None) -> Dict[str, Any]:
        """
        Runs the LLM + Tools execution loop.
        Uses OpenRouter API via LangChain ChatOpenAI if OPENROUTER_API_KEY or OPENAI_API_KEY is available.
        Otherwise, runs a rule-based fallback tool loop for local simulation.
        """
        user_prompt = context_ram["user_prompt"]
        system_prompt = context_ram["system_prompt"]
        chat_history = context_ram["chat_history"]

        # Select dynamic model
        selected_model = model or context_ram.get("model") or self.model_name or settings.DEFAULT_MODEL

        # Normalization mapping for common model names
        model_aliases = {
            "gpt-4o": "openai/gpt-4o",
            "gpt-4o-mini": "openai/gpt-4o-mini",
            "claude-3-5-sonnet": "anthropic/claude-3.5-sonnet",
            "claude-3.5-sonnet": "anthropic/claude-3.5-sonnet",
            "gemini-1.5-pro": "google/gemini-pro-1.5",
            "gemini-2.5-flash": "google/gemini-2.5-flash",
            "llama-3.1-groq": "meta-llama/llama-3.3-70b-instruct",
            "llama-3.3-70b": "meta-llama/llama-3.3-70b-instruct",
            "deepseek-chat": "deepseek/deepseek-chat",
        }
        openrouter_model = model_aliases.get(selected_model.lower(), selected_model)

        tool_calls_executed = []
        
        # Check if user prompt requests tool execution
        lower_prompt = user_prompt.lower()
        if "meeting" in lower_prompt or "reunião" in lower_prompt or "agendar" in lower_prompt:
            tool_res = self.tool_map["schedule_meeting"].invoke({
                "participant": "Client Executive",
                "topic": "Project Timeline & Requirements",
                "date_str": "2026-08-10 14:00"
            })
            tool_calls_executed.append({"tool": "schedule_meeting", "response": tool_res})
        
        if "crm" in lower_prompt or "cliente" in lower_prompt:
            tool_res = self.tool_map["crm_read_write"].invoke({
                "action": "read",
                "customer_id": "CUST_99182"
            })
            tool_calls_executed.append({"tool": "crm_read_write", "response": tool_res})

        if "pagamento" in lower_prompt or "payment" in lower_prompt or "fatura" in lower_prompt:
            tool_res = self.tool_map["fetch_payment_info"].invoke({
                "account_id": "ACC_4412"
            })
            tool_calls_executed.append({"tool": "fetch_payment_info", "response": tool_res})

        api_key = settings.OPENROUTER_API_KEY

        # Synthesize final response
        if api_key:
            try:
                from langchain_openai import ChatOpenAI
                from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
                
                callbacks = []
                if (
                    settings.LANGFUSE_ENABLED
                    and settings.LANGFUSE_CAPTURE_CONTENT
                    and settings.LANGFUSE_PUBLIC_KEY
                    and settings.LANGFUSE_SECRET_KEY
                ):
                    try:
                        from langfuse.langchain import CallbackHandler
                        lf_handler = CallbackHandler(
                            public_key=settings.LANGFUSE_PUBLIC_KEY
                        )
                        callbacks.append(lf_handler)
                    except Exception as lf_err:
                        print(f"[AgentLoop] Could not attach Langfuse CallbackHandler: {lf_err}")

                llm = ChatOpenAI(
                    model=openrouter_model,
                    openai_api_key=api_key,
                    openai_api_base=settings.OPENROUTER_BASE_URL,
                    callbacks=callbacks if callbacks else None,
                    default_headers={
                        "HTTP-Referer": "http://localhost:3000",
                        "X-Title": "Agent Timeline"
                    }
                )
                messages = [SystemMessage(content=system_prompt)]
                for msg in chat_history:
                    if msg.get("sender") == "user":
                        messages.append(HumanMessage(content=msg.get("content", "")))
                    else:
                        messages.append(AIMessage(content=msg.get("content", "")))
                
                if tool_calls_executed:
                    tool_context = "\n".join(f"Tool [{tc['tool']}]: {tc['response']}" for tc in tool_calls_executed)
                    messages.append(HumanMessage(content=f"User Request: {user_prompt}\n\nTool Results:\n{tool_context}"))
                else:
                    messages.append(HumanMessage(content=user_prompt))

                response = llm.invoke(messages, config={"callbacks": callbacks} if callbacks else None)
                raw_reply = response.content
            except Exception as e:
                raw_reply = f"[OpenRouter Dynamic Model: {openrouter_model}] Response synthesized. (API call note: {str(e)}). User Prompt: '{user_prompt}'"
        else:
            if tool_calls_executed:
                tool_summary = " ".join(f"[{tc['tool']} -> {tc['response']}]" for tc in tool_calls_executed)
                raw_reply = f"[OpenRouter Model: {openrouter_model}] Processed request using tools: {tool_summary}. Answer to '{user_prompt}' prepared."
            else:
                raw_reply = f"[OpenRouter Model: {openrouter_model}] Agent response for prompt: '{user_prompt}'. Everything is running smoothly according to working memory."

        return {
            "raw_reply": raw_reply,
            "tool_calls": tool_calls_executed,
            "model": openrouter_model
        }
