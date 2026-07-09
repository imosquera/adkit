"""Single source of truth for the differentiation reference (me-too copy signal).

These are immutable, declarative values (frozen tuples / NamedTuples) — never
computed via side effects (constitution Principle III/VI; FP-003). They are imported
by audit/scoring.py (me-too copy detection), so the "who we differentiate from"
knowledge has ONE authoritative home (constitution Principle X — DRY; FR-016).
"""
from __future__ import annotations

from typing import NamedTuple


class DifferentiationAxis(NamedTuple):
    """One axis a competitor like ChatGPT cannot easily replicate. `triggers` are the
    lowercase lexemes whose presence in an ad's copy counts the axis as covered."""

    name: str
    triggers: tuple[str, ...]


# The three axes from FR-015. Copy that leads with these reads as a vertical product,
# not a general-purpose AI chat tool.
DIFFERENTIATION_AXES: tuple[DifferentiationAxis, ...] = (
    DifferentiationAxis(
        "integration",
        ("crm", "integrat", "stack", "workflow", "connect", "sync", "plug", "api",
         "hubspot", "salesforce", "zendesk", "marketing stack"),
    ),
    DifferentiationAxis(
        "consistency",
        ("brand voice", "brand-voice", "voice-matched", "voice matched", "on-brand",
         "on brand", "consistent", "consistency", "tone", "every channel", "across channels"),
    ),
    DifferentiationAxis(
        "outcome",
        ("sign-up", "sign up", "signup", "conversion", "convert", "reply rate",
         "response rate", "revenue", "roi", "pipeline", "leads", "book", "close"),
    ),
)

# Phrases that mark copy as an undifferentiated, general-AI-tool promise (FR-014).
GENERIC_AI_PHRASES: tuple[str, ...] = (
    "ai writer", "ai writing", "ai chatbot", "ai chat", "ai assistant", "ai bot",
    "chatbot", "ai-powered writing", "ai content", "ask ai", "powered by ai",
    "generative ai", "smart assistant",
)

# The competitor set the differentiation judgement is made relative to (FR-014/FR-016).
DIFFERENTIATION_COMPETITORS: tuple[str, ...] = ("ChatGPT", "Claude", "Gemini", "Copilot")
