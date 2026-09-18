import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
const HERE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), ".");
const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC_SCRIPT = resolve(HERE_DIR, "sync-models.py");
const MODELS_CONFIG = resolve(AGENT_DIR, "models.json");

interface ModelsConfig {
  providers?: Record<string, {
    baseUrl?: string;
    apiKey?: string;
    models?: Array<{
      id?: string;
      name?: string;
      thinkingLevelMap?: {
        off?: string | null;
      };
      compat?: {
        thinkingFormat?: string;
      };
      samplingParams?: {
        chat_template_kwargs?: {
          preserve_thinking?: boolean;
        };
      };
    }>;
  }>;
}

async function readModelsConfig(): Promise<ModelsConfig> {
  try {
    return JSON.parse(await readFile(MODELS_CONFIG, "utf8")) as ModelsConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

interface ServerModel {
  id: string;
  /** Non-chat models are tagged (e.g. "text-to-image"); chat models omit this. */
  task?: string | null;
  quant?: string;
  loaded?: boolean;
  context_length?: number;
  max_context_length?: number;
  native_context_length?: number;
}

interface LoadedModelInfo {
  /** Provider key in models.json (needed to look the model up in the registry). */
  provider: string;
  /** Model id as registered in models.json (includes the quantization when present). */
  modelId: string;
  /** Model id as reported by the server, without quantization suffix. */
  serverId: string;
  name: string;
  contextLength: number | null;
  hasVision: boolean | null; // null = unknown
}

async function fetchLoadedModel(): Promise<LoadedModelInfo | null> {
  const config = await readModelsConfig();
  const providers = Object.entries(config.providers ?? {});
  // Prefer the provider pi is currently using, fall back to the first one.
  const [providerName, provider] = providers.find(([name]) => name === process.env.PI_PROVIDER) ?? providers[0] ?? [];
  if (!providerName || !provider) throw new Error("no providers in models.json");
  if (!provider?.baseUrl) throw new Error("provider has no baseUrl");

  let resp: Response;
  try {
    resp = await fetch(provider.baseUrl.replace(/\/$/, "") + "/models", {
      headers: { Authorization: `Bearer ${provider.apiKey ?? ""}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new Error(`cannot reach ${provider.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!resp.ok) throw new Error(`server returned HTTP ${resp.status}`);

  const payload = (await resp.json()) as { data?: ServerModel[] };
  const chatTasks = new Set([undefined, null, "text-generation", "chat", "completion"]);
  const loaded = (payload.data ?? []).find((model) => model.loaded && chatTasks.has(model.task));
  if (!loaded) return null; // nothing in memory — legitimately empty

  const id = loaded.quant ? `${loaded.id}:${loaded.quant}` : loaded.id;
  const entry =
    (provider.models ?? []).find((model) => model.id === id) ??
    (provider.models ?? []).find((model) => model.id === loaded.id);

  let contextLength: number | null = null;
  // On unsloth-studio, `context_length` is the context actually allocated in memory;
  // `max_context_length` mirrors the active --reasoning-budget (set via /reasoning-budget apply),
  // and `native_context_length` is the GGUF-trained max. None of those are the loaded context.
  const fields = ["context_length", "max_context_length", "native_context_length"] as const;
  for (const field of fields) {
    const value = loaded[field];
    if (typeof value === "number" && value > 0) {
      contextLength = value;
      break;
    }
  }

  // Best effort: Studio's /api/models/list reports is_vision per model.
  let hasVision: boolean | null = null;
  try {
    const base = new URL(provider.baseUrl);
    const listResp = await fetch(`${base.protocol}//${base.host}/api/models/list`, {
      headers: { Authorization: `Bearer ${provider.apiKey ?? ""}` },
      signal: AbortSignal.timeout(5000),
    });
    if (listResp.ok) {
      const list = (await listResp.json()) as { models?: Array<{ id?: string; is_vision?: boolean }> };
      hasVision = (list.models ?? []).find((model) => model.id === loaded.id)?.is_vision ?? null;
    }
  } catch {
    // ignore — vision info is optional
  }

  return {
    provider: providerName,
    modelId: entry?.id ?? id,
    serverId: loaded.id,
    name: entry?.name ?? entry?.id ?? id,
    contextLength,
    hasVision,
  };
}

async function qwenThinkingIsValid(): Promise<boolean> {
  const config = await readModelsConfig();
  const qwenModels = Object.values(config.providers ?? {}).flatMap((provider) =>
    (provider.models ?? []).filter((model) => model.id?.toLowerCase().includes("qwen3.8"))
  );
  return qwenModels.length === 0 || qwenModels.every((model) =>
    model.thinkingLevelMap?.off === "none"
    && model.compat?.thinkingFormat === "qwen"
    && model.samplingParams?.chat_template_kwargs?.preserve_thinking === true
  );
}

type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

function normalize(value: string): string {
  return value.toLowerCase();
}

/** Candidate ids for the loaded model: quantized id first, then the bare server id. */
function candidateIds(loaded: LoadedModelInfo): string[] {
  const candidates: string[] = [];
  for (const id of [loaded.modelId, loaded.serverId]) {
    if (!candidates.some((seen) => normalize(seen) === normalize(id))) candidates.push(id);
  }
  return candidates;
}

function isCurrentModel(model: PiModel | undefined, loaded: LoadedModelInfo): boolean {
  if (!model || model.provider !== loaded.provider) return false;
  const current = normalize(model.id);
  return candidateIds(loaded).some((id) => normalize(id) === current);
}

function findRegistryModel(registry: ModelRegistry, loaded: LoadedModelInfo): PiModel | undefined {
  for (const id of candidateIds(loaded)) {
    const model = registry.find(loaded.provider, id);
    if (model) return model;
  }
  // Fall back to a case-insensitive scan of the available catalogue.
  const candidates = candidateIds(loaded).map(normalize);
  return registry
    .getAvailable()
    .find((model) => model.provider === loaded.provider && candidates.includes(normalize(model.id)));
}

type LoadedReport = { loaded: LoadedModelInfo; label: string };

async function describeLoadedModel(ctx: ExtensionContext): Promise<LoadedReport | null> {
  let loaded: LoadedModelInfo | null;
  try {
    loaded = await fetchLoadedModel();
  } catch (error) {
    ctx.ui.notify(`Loaded model: unavailable (${error instanceof Error ? error.message : String(error)})`, "error");
    return null;
  }
  if (!loaded) {
    ctx.ui.notify("No model loaded on server", "warning");
    return null;
  }
  const details = [
    loaded.contextLength ? `context ${loaded.contextLength}` : null,
    loaded.hasVision === null ? null : loaded.hasVision ? "vision" : "text-only",
  ].filter(Boolean).join(", ");
  return { loaded, label: `${loaded.name}${details ? ` (${details})` : ""}` };
}

async function showLoadedModel(ctx: ExtensionContext): Promise<void> {
  const report = await describeLoadedModel(ctx);
  if (report) ctx.ui.notify(`Loaded model: ${report.label}`, "info");
}

/** Switch the session to whichever model is currently resident in server memory. */
async function useLoadedModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const report = await describeLoadedModel(ctx);
  if (!report) return;
  const { loaded, label } = report;

  if (isCurrentModel(ctx.model, loaded)) {
    ctx.ui.notify(`Loaded model: ${label} (already active)`, "info");
    return;
  }

  const model = findRegistryModel(ctx.modelRegistry, loaded);
  if (!model) {
    ctx.ui.notify(`Loaded model: ${label} — no matching entry in models.json. Run /sync-models to add it`, "warning");
    return;
  }

  if (ctx.scopedModels.length > 0 && !ctx.scopedModels.some((scoped) => scoped.model.id === model.id)) {
    ctx.ui.notify(`Loaded model: ${label} is outside this session's model scope`, "warning");
    return;
  }

  if (await pi.setModel(model)) {
    ctx.ui.notify(`Switched to loaded model: ${label}`, "info");
  } else {
    ctx.ui.notify(`Cannot switch to ${label}: no credentials for provider "${model.provider}"`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  let syncing = false;

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    // Fire-and-forget so startup is not blocked by the server fetch.
    void useLoadedModel(pi, ctx);
  });

  pi.registerCommand("model-loaded", {
    description: 'Show which model is loaded in server memory ("use" switches to it)',
    getArgumentCompletions: (prefix) => {
      const option = { value: "use", label: "use", description: "Switch the session to the loaded model" };
      return option.value.startsWith(prefix.trim().toLowerCase()) ? [option] : null;
    },
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      if (!argument) await showLoadedModel(ctx);
      else if (argument === "use") await useLoadedModel(pi, ctx);
      else ctx.ui.notify("Usage: /model-loaded [use]", "error");
    },
  });

  pi.registerCommand("sync-models", {
    description: "Pull the latest server models (one entry per downloaded GGUF quantization) into models.json and reload Pi",
    getArgumentCompletions: (prefix) => {
      const option = { value: "all", label: "all", description: "Include embedding models" };
      return option.value.startsWith(prefix.trim().toLowerCase()) ? [option] : null;
    },
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase();
      if (argument && argument !== "all") {
        ctx.ui.notify("Usage: /sync-models [all]", "error");
        return;
      }

      if (syncing) {
        ctx.ui.notify("Model synchronization is already running", "warning");
        return;
      }

      syncing = true;
      const scriptArgs = [SYNC_SCRIPT, "--config", MODELS_CONFIG];
      if (argument === "all") scriptArgs.push("--include-all");

      try {
        const config = await readModelsConfig();
        const providers = Object.entries(config.providers ?? {});
        if (providers.length > 1) {
          throw new Error("models.json must contain at most one provider");
        }

        const promptRequired = async (title: string, placeholder: string): Promise<string> => {
          const value = (await ctx.ui.input(title, placeholder))?.trim();
          if (!value) throw new Error("Setup cancelled");
          return value;
        };

        if (providers.length === 0) {
          const providerName = await promptRequired("Provider name", "thread");
          scriptArgs.push("--provider-name", providerName);
        }

        const provider = providers[0]?.[1];
        if (!provider?.baseUrl) {
          const ip = await promptRequired("Server IP or hostname", "192.168.1.10");
          const port = await promptRequired("Server port", "8888");
          const portNumber = Number(port);
          if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
            throw new Error("Server port must be between 1 and 65535");
          }
          scriptArgs.push("--ip", ip, "--port", String(portNumber));
        }

        if (!provider?.apiKey) {
          const apiKey = await promptRequired("API key", "sk-...");
          scriptArgs.push("--api-key", apiKey);
        }
      } catch (error) {
        syncing = false;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, message === "Setup cancelled" ? "warning" : "error");
        return;
      }

      ctx.ui.notify("Synchronizing models…", "info");

      let result;
      try {
        result = await pi.exec("python3", scriptArgs, {
          cwd: AGENT_DIR,
          timeout: 30_000,
        });
      } catch (error) {
        syncing = false;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Model synchronization failed: ${message}`, "error");
        return;
      }

      if (result.code !== 0) {
        syncing = false;
        const error = result.stderr.trim() || result.stdout.trim() || `sync exited with code ${result.code}`;
        ctx.ui.notify(`Model synchronization failed: ${error}`, "error");
        return;
      }

      if (!(await qwenThinkingIsValid())) {
        syncing = false;
        ctx.ui.notify("Model synchronization failed: Qwen3.8 thinking configuration is incomplete", "error");
        return;
      }

      syncing = false;
      const [header, ...modelIds] = result.stdout.trim().split("\n").map((line) => line.trim());
      const question = `Reload Pi now to apply?`;
      const body = [header, "", ...modelIds].join("\n");
      if (await ctx.ui.confirm("Models synchronized", `${body}\n\n${question}`)) await ctx.reload();
      else ctx.ui.notify("Reload cancelled — new models will apply on next restart", "info");
      return;
    },
  });
}
