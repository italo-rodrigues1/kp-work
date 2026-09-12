from typing import Dict, Any, Tuple

class Guardrails:
    """
    Guardrails engine checking input prompts and LLM generated replies
    before final delivery to the user.
    """
    def __init__(self):
        self.blocked_keywords = ["UNSAFE_EXPLICIT_DATA_DUMP", "DROP TABLE"]

    def validate_input(self, prompt: str) -> Tuple[bool, str]:
        """
        Validates incoming user prompt against safety standards.
        """
        for word in self.blocked_keywords:
            if word in prompt:
                return False, f"Prompt violates safety policy: Contains blocked keyword '{word}'."
        return True, ""

    def validate_output(self, reply: str) -> Tuple[bool, str]:
        """
        Validates LLM output before generating final Reply.
        """
        if not reply or len(reply.strip()) == 0:
            return False, "Guardrail alert: Empty response generated."
        return True, reply
