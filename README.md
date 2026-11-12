# Tiered Coding Orchestrator

A small TypeScript CLI (`orch`) that runs coding tasks on a local Ollama model first, verifies the
result, and escalates to the `claude` CLI only when verification fails. Zero money spent: no API
keys, no billing.

Work in progress. The design is in [CLAUDE.md](CLAUDE.md).
