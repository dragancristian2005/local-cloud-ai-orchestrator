import type { BackendConfig } from "../core/config.ts";
import { ConfigError } from "../core/types.ts";
import type { Backend } from "../core/types.ts";
import { OllamaBackend } from "./ollama.ts";

export type { Backend, BackendRequest, BackendResult } from "../core/types.ts";

/** Build a backend from its config entry. `overrides.model` replaces the model of an Ollama backend only. */
export function createBackend(id: string, cfg: BackendConfig, overrides: { model?: string } = {}): Backend {
  switch (cfg.type) {
    case "ollama":
      return new OllamaBackend(id, overrides.model ? { ...cfg, model: overrides.model } : cfg);
    case "claude-cli":
      throw new ConfigError(`backend "${id}": the claude-cli backend is not available yet`);
  }
}
