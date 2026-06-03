# Contributing to MDVR

Thanks for helping improve MDVR.

## Local setup

Start from the current repo layout.

Typical workflow:

```bash
pip install -r requirements.txt -r requirements-dev.txt
```

If Docker is part of the change:

```bash
docker compose up -d --build
```

If a command is not already documented in the repo, do not invent one.
Add a TODO in the docs or the PR description instead.

## Tests

Run whatever tests exist in the repository.

Current checks known in this repo include:

```bash
pytest -q tests/test_mdvr_core.py
python -m py_compile main.py tools/mdvr_link.py tests/test_mdvr_core.py
node --check app/static/app.js
node --check app/static/excalidraw-bridge.js
```

If you add new tests, keep them focused and deterministic.

## Lint/build

No dedicated lint command is currently documented here.
If you add one, update this file.

Docker validation is also useful:

```bash
docker compose up -d --build
```

## Contribution priorities

Please prioritize work in this order:

1. safety
2. docs
3. tests
4. Excalidraw rendering
5. config validation
6. Docker usability

## Pull request expectations

A good PR should:
- explain the user-visible change
- note any safety impact
- include tests or explain why tests were not added
- update docs when config, permissions, or Docker behavior changes

## Good first issue ideas

- tighten a warning or validation message
- add a small test for a boundary case
- improve docs around config or Docker
- make a UI permission label clearer
- reduce a misleading legacy reference

## Final note

Do not weaken auth, permission checks, or path safety to make a feature easier.
