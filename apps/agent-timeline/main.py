import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any

from config import settings
from harness.agent_run import AIAgentRun
from worker import AgentWorker

# Instantiate AI Agent Harness and Worker
agent_harness = AIAgentRun()
agent_worker = AgentWorker()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: start RabbitMQ consumer & MinIO worker
    print("🚀 Starting Agent Timeline Worker...")
    agent_worker.start()
    yield
    # Shutdown: stop worker
    print("🛑 Stopping Agent Timeline Worker...")
    agent_worker.stop()

app = FastAPI(
    title=settings.APP_NAME,
    description="Agent Timeline Microservice implementing Harness & LLM Ops Flowchart Architecture with RabbitMQ & MinIO",
    version="1.0.0",
    lifespan=lifespan
)

class AgentRunRequest(BaseModel):
    user_prompt: str = Field(..., description="Prompt sent by the user")
    workspace_id: str = Field(default="workspace-default", description="Workspace isolation boundary")
    thread_id: str = Field(default="default_thread", description="Thread / Conversation ID")
    system_prompt: Optional[str] = Field(default="", description="Optional custom System Prompt override")

class AgentRunResponse(BaseModel):
    run_id: str
    workspace_id: str
    thread_id: str
    reply: str
    tool_calls: List[Dict[str, Any]]
    working_memory_context: Dict[str, Any]
    summarizer_status: Dict[str, Any]
    llm_ops: Dict[str, Any]

@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": settings.APP_NAME,
        "environment": settings.ENVIRONMENT
    }

@app.post("/api/agent/run", response_model=AgentRunResponse)
def execute_agent_run(request: AgentRunRequest):
    try:
        result = agent_harness.run(
            user_prompt=request.user_prompt,
            thread_id=request.thread_id,
            workspace_id=request.workspace_id,
            system_prompt=request.system_prompt or ""
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent Run failed: {str(e)}")

@app.get("/api/agent/skills")
def get_skills():
    return {
        "procedural_rules": agent_harness.procedural.get_skill_instructions()
    }

@app.post("/api/agent/distill")
def distill_facts():
    raw_data = agent_harness.procedural.export_raw_data_for_distillation()
    facts = agent_harness.summarizer.distill_facts_from_db1(raw_data)
    return {
        "distilled_facts": facts,
        "count": len(facts)
    }

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=settings.PORT, reload=True)
