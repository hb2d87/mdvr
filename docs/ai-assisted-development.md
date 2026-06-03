# AI-assisted Development Note

mdvr was created with LLM assistance.

That disclosure exists for a few reasons:

- it is honest about how the code was produced
- it reminds maintainers to review the code carefully
- it lowers the chance that people assume every detail was handwritten and manually validated

## What that means in practice

- Human-led product direction still matters
- Human review still matters
- Careful testing still matters
- Security-sensitive changes deserve extra caution

AI assistance can help move faster, but it can also miss edge cases.
Treat the code as something to inspect, not something to trust blindly.

## Suggested README Wording

If you want a short public disclosure, this is a reasonable form:

> mdvr is a small self-hosted browser app for reading Markdown vaults. It was created with LLM assistance.

## Maintenance note

If AI-assisted code is accepted into the repo:
- keep the code review process strict
- run tests before merge
- be cautious about permission changes, auth changes, and filesystem code
