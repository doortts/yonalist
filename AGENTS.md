# Yonalist agent guidance

Before planning or implementing any feature, bug fix, behavior change,
refactor, or user-visible verification in this repository, read and apply
both:

- `.agents/skills/fable-opus-loop/SKILL.md` — who does which phase. Fable 5
  designs and adversarially reviews, Opus 5 xHigh implements, review loops
  back to rework until it passes. This is the default for all non-trivial
  work; do not implement straight from the request.
- `.agents/skills/delivering-yonalist-changes/SKILL.md` — how a change ships
  here: contract, vertical slice, gates, evidence.

Keep this file concise. When a repeated project-specific failure reveals a
workflow gap, update the repository skill rather than duplicating detailed
instructions here. Read-only explanations and status reports may skip the
delivery workflow unless they lead into a change.
