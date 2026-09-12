from typing import Dict, Any, List, Callable

class SimpleTool:
    def __init__(self, name: str, description: str, func: Callable):
        self.name = name
        self.description = description
        self.func = func

    def invoke(self, kwargs: Dict[str, Any]) -> str:
        return self.func(**kwargs)

def schedule_meeting_fn(participant: str, topic: str, date_str: str) -> str:
    return f"Meeting successfully scheduled with {participant} on {date_str} regarding '{topic}'."

def crm_read_write_fn(action: str, customer_id: str, data: str = "") -> str:
    if action == "read":
        return f"CRM Record for {customer_id}: VIP Status Active, Last Contact 2026-08-01."
    elif action == "write":
        return f"CRM Record updated for {customer_id} with payload: '{data}'."
    return f"Invalid action '{action}'. Use 'read' or 'write'."

def fetch_payment_info_fn(account_id: str) -> str:
    return f"Payment Info for Account {account_id}: Status Paid, Plan Enterprise Tier, Next Billing Date: 2026-09-01."


try:
    from langchain_core.tools import tool

    @tool
    def schedule_meeting(participant: str, topic: str, date_str: str) -> str:
        """Schedules a meeting with a participant on a specified date and topic."""
        return schedule_meeting_fn(participant, topic, date_str)

    @tool
    def crm_read_write(action: str, customer_id: str, data: str = "") -> str:
        """Reads or writes customer information in the CRM system."""
        return crm_read_write_fn(action, customer_id, data)

    @tool
    def fetch_payment_info(account_id: str) -> str:
        """Fetches payment info and subscription status for a given account ID."""
        return fetch_payment_info_fn(account_id)

    def get_available_tools() -> List[Any]:
        return [schedule_meeting, crm_read_write, fetch_payment_info]

except ImportError:
    # Standalone tools fallback if langchain is not installed
    schedule_meeting_tool = SimpleTool("schedule_meeting", "Schedule meeting tool", schedule_meeting_fn)
    crm_tool = SimpleTool("crm_read_write", "CRM read/write tool", crm_read_write_fn)
    payment_tool = SimpleTool("fetch_payment_info", "Fetch payment info tool", fetch_payment_info_fn)

    def get_available_tools() -> List[Any]:
        return [schedule_meeting_tool, crm_tool, payment_tool]
