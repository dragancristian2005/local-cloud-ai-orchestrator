import type { BackendConfig } from "../core/config.ts";
import { ConfigError } from "../core/types.ts";
import type { Backend } from "../core/types.ts";
import { ClaudeCliBackend } from "./claude-cli.ts";
import { OllamaBackend } from "./ollama.ts";

export type { Backend, BackendRequest, BackendResult } from "../core/types.ts";

/** Build a backend from its config entry. `overrides.model` replaces the model of an Ollama backend only. */
export function createBackend(id: string, cfg: BackendConfig, overrides: { model?: string } = {}): Backend {
  switch (cfg.type) {
    case "ollama":
      // The committed config ships with a placeholder. Used as is, every run would look like a PC
      // outage and quietly go to Claude.
      if (/\/\/PC_ADDRESS\b/i.test(cfg.baseUrl)) {
        throw new ConfigError(
          `backend "${id}" still has the placeholder address PC_ADDRESS: put your PC's address in config/orchestrator.local.json (see docs/SETUP.md, Part 2, step 4)`,
        );
      }
      return new OllamaBackend(id, overrides.model ? { ...cfg, model: overrides.model } : cfg);
    case "claude-cli":
      return new ClaudeCliBackend(id, cfg);
  }
}
