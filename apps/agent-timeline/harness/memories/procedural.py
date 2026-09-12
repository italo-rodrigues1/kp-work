import os
from typing import List, Dict, Any

class ProceduralMemory:
    """
    Procedural Memory loads files and instructions (e.g. Skill.md)
    defining how the agent should act and guidelines to adhere to.
    """
    def __init__(self, skills_dir: str = "../.agents/skills"):
        self.skills_dir = skills_dir

    def get_skill_instructions(self, skill_name: str = "") -> str:
        """
        Reads instructions from Skill.md files or fallback instructions.
        """
        instructions = []
        if os.path.exists(self.skills_dir):
            for root, _, files in os.walk(self.skills_dir):
                for f in files:
                    if f.endswith(".md"):
                        path = os.path.join(root, f)
                        try:
                            with open(path, "r", encoding="utf-8") as file:
                                instructions.append(f"--- Skill [{f}] ---\n" + file.read())
                        except Exception:
                            pass

        if not instructions:
            instructions.append(
                "Default Procedural Rule: Act as a helpful, polite, and precise AI assistant. "
                "Adhere to formatting standards and verify information when using tools."
            )
        
        return "\n\n".join(instructions)

    def export_raw_data_for_distillation(self) -> List[Dict[str, Any]]:
        """
        DB1 data extractor for distillation into facts by the Summarizer.
        """
        return [{
            "type": "procedural_rules",
            "content": self.get_skill_instructions()
        }]
