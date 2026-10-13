import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
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

/**
 * models.json as parsed, without dropping the fields this file does not model
 * (provider `api`, `compat`, model `contextWindow`, …): entries are mutated in place.
 */
interface RawProvider {
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: unknown[];
  [key: string]: unknown;
}

interface RawConfig {
  providers?: Record<string, RawProvider>;
  [key: string]: unknown;
}

async function readRawConfig(): Promise<RawConfig> {
  try {
    return JSON.parse(await readFile(MODELS_CONFIG, "utf8")) as RawConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeRawConfig(config: RawConfig): Promise<void> {
  const temp = `${MODELS_CONFIG}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`);
  await rename(temp, MODELS_CONFIG);
}

/** Error message when the URL cannot be used by sync-models.py, otherwise null. */
function baseUrlProblem(value: string): string | null {
  try {
    const url = new URL(value);
    if (!url.hostname) return "base URL must include a host";
    // shortcut: the sync script only prompts for a port on a TTY, which Pi does not provide.
    if (!url.port) return "base URL must include a port (http://host:8888/v1)";
    return null;
  } catch {
    return "base URL must look like http://host:port/v1";
  }
}

async function promptRequired(ctx: ExtensionContext, label: string, placeholder: string): Promise<string> {
  const value = (await ctx.ui.input(label, placeholder))?.trim();
  if (!value) throw new Error("Setup cancelled");
  return value;
}

/** Empty answer keeps the current value. */
async function promptKeep(ctx: ExtensionContext, label: string, current: string): Promise<string> {
  const value = (await ctx.ui.input(current ? `${label} [${current}]` : label, current || undefined))?.trim();
  return value || current;
}

/** One subprocess run for one provider; a dead server only costs its own provider. */
async function syncProvider(pi: ExtensionAPI, name: string, args: string[]): Promise<string> {
  const result = await pi.exec("python3", [SYNC_SCRIPT, "--config", MODELS_CONFIG, "--provider-name", name, ...args], {
    cwd: AGENT_DIR,
    timeout: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `sync exited with code ${result.code}`);
  }
  return result.stdout.trim();
}

async function reloadAfterSync(ctx: ExtensionCommandContext, synced: string[], failed: string[]): Promise<boolean> {
  if (synced.length === 0) {
    ctx.ui.notify(`Model synchronization failed: ${failed.join(" | ")}`, "error");
    return false;
  }
  if (!(await qwenThinkingIsValid())) {
    ctx.ui.notify("Model synchronization failed: Qwen3.8 thinking configuration is incomplete", "error");
    return false;
  }
  const body = [...synced, ...failed.map((line) => `Skipped ${line}`)].join("\n\n");
  if (await ctx.ui.confirm("Models synchronized", `${body}\n\nReload Pi now to apply?`)) await ctx.reload();
  else ctx.ui.notify("Reload cancelled — new models will apply on next restart", "info");
  return true;
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

type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

/** Providers to try, current pi provider first, then the rest in config order. */
function providerOrder(config: ModelsConfig): Array<[string, ProviderConfig]> {
  const providers = Object.entries(config.providers ?? {});
  const current = process.env.PI_PROVIDER;
  return [
    ...providers.filter(([name]) => name === current),
    ...providers.filter(([name]) => name !== current),
  ];
}

/** Best effort: Studio's /api/models/list reports is_vision per model. */
async function visionFlags(provider: ProviderConfig): Promise<Map<string, boolean>> {
  const flags = new Map<string, boolean>();
  try {
    const base = new URL(provider.baseUrl!);
    const resp = await fetch(`${base.protocol}//${base.host}/api/models/list`, {
      headers: { Authorization: `Bearer ${provider.apiKey ?? ""}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const list = (await resp.json()) as { models?: Array<{ id?: string; is_vision?: boolean }> };
      for (const model of list.models ?? []) {
        if (model.id && typeof model.is_vision === "boolean") flags.set(model.id, model.is_vision);
      }
    }
  } catch {
    // ignore — vision info is optional
  }
  return flags;
}

async function fetchLoadedFromProvider(providerName: string, provider: ProviderConfig): Promise<LoadedModelInfo[]> {
  if (!provider.baseUrl) throw new Error("provider has no baseUrl");

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
  const chat = (payload.data ?? []).filter((model) => chatTasks.has(model.task));
  // Studio flags residency with `loaded`; llama.cpp-style servers omit the field and list
  // only what is in memory, so for those every chat model counts as loaded.
  const resident = chat.some((model) => model.loaded !== undefined)
    ? chat.filter((model) => model.loaded)
    : chat.slice(0, 1);
  if (resident.length === 0) return []; // nothing in memory — legitimately empty

  const vision = await visionFlags(provider);
  return resident.map((loaded) => {

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
  const hasVision = vision.has(loaded.id) ? vision.get(loaded.id)! : null;

  return {
    provider: providerName,
    modelId: entry?.id ?? id,
    serverId: loaded.id,
    name: entry?.name ?? entry?.id ?? id,
    contextLength,
    hasVision,
  };
  });
}

/** Ask every provider what it has in memory; unreachable ones are reported as failures. */
async function fetchLoadedModels(): Promise<{ models: LoadedModelInfo[]; failures: string[] }> {
  const providers = providerOrder(await readModelsConfig());
  if (providers.length === 0) throw new Error("no providers in models.json");

  const models: LoadedModelInfo[] = [];
  const failures: string[] = [];
  for (const [providerName, provider] of providers) {
    try {
      const loaded = await fetchLoadedFromProvider(providerName, provider);
      models.push(...loaded);
    } catch (error) {
      failures.push(`${providerName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { models, failures };
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

async function describeLoadedModels(ctx: ExtensionContext): Promise<LoadedReport[]> {
  let result: { models: LoadedModelInfo[]; failures: string[] };
  try {
    result = await fetchLoadedModels();
  } catch (error) {
    ctx.ui.notify(`Loaded model: unavailable (${error instanceof Error ? error.message : String(error)})`, "error");
    return [];
  }
  // A dead provider must not masquerade as "nothing loaded anywhere".
  if (result.failures.length > 0) ctx.ui.notify(`Unreachable providers: ${result.failures.join(" | ")}`, "warning");
  if (result.models.length === 0) {
    ctx.ui.notify("No model loaded on any server", "warning");
    return [];
  }
  return result.models.map((loaded) => {
    const details = [
      loaded.contextLength ? `context ${loaded.contextLength}` : null,
      loaded.hasVision === null ? null : loaded.hasVision ? "vision" : "text-only",
    ].filter(Boolean).join(", ");
    return { loaded, label: `${loaded.name}${details ? ` (${details})` : ""}` };
  });
}

function displayName(report: LoadedReport): string {
  return `${report.loaded.provider}: ${report.label}`;
}

async function showLoadedModel(ctx: ExtensionContext): Promise<void> {
  const reports = await describeLoadedModels(ctx);
  if (reports.length === 1) ctx.ui.notify(`Loaded model: ${reports[0].label}`, "info");
  else if (reports.length > 1) ctx.ui.notify(`Loaded models:\n${reports.map(displayName).join("\n")}`, "info");
}

/** Switch the session to whichever model is currently resident in server memory. */
async function useLoadedModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const reports = await describeLoadedModels(ctx);
  if (reports.length === 0) return;

  const alreadyActive = reports.find((report) => isCurrentModel(ctx.model, report.loaded));
  if (alreadyActive) {
    ctx.ui.notify(`Loaded model: ${alreadyActive.label} (already active)`, "info");
    return;
  }

  let { loaded, label } = reports[0];
  if (reports.length > 1) {
    const picked = await ctx.ui.select("Loaded models — which one to activate?", reports.map(displayName));
    const chosen = reports.find((report) => displayName(report) === picked);
    if (!chosen) {
      ctx.ui.notify("Switch cancelled", "warning");
      return;
    }
    ({ loaded, label } = chosen);
  }

  const model = findRegistryModel(ctx.modelRegistry, loaded);
  if (!model) {
    ctx.ui.notify(`Loaded model: ${label} — no matching entry in models.json. Run /sync-models to add it`, "warning");
    return;
  }

  if (ctx.scopedModels.length > 0 && !ctx.scopedModels.some((scoped) => scoped.model.id === model.id && scoped.model.provider === model.provider)) {
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

  async function syncOne(name: string, ctx: ExtensionCommandContext): Promise<boolean> {
    syncing = true;
    ctx.ui.notify("Synchronizing models…", "info");
    const synced: string[] = [];
    const failed: string[] = [];
    try {
      synced.push(await syncProvider(pi, name, []));
    } catch (error) {
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    syncing = false;
    return reloadAfterSync(ctx, synced, failed);
  }

  async function listProviders(ctx: ExtensionContext): Promise<void> {
    const entries = Object.entries((await readRawConfig()).providers ?? {});
    if (entries.length === 0) {
      ctx.ui.notify("No providers in models.json — use /provider add", "warning");
      return;
    }
    const lines = entries.map(
      ([name, provider]) => `${name} — ${provider.baseUrl ?? "no baseUrl"} (${(provider.models ?? []).length} models)`,
    );
    ctx.ui.notify(`Providers:\n${lines.join("\n")}`, "info");
  }

  async function addProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext, name?: string): Promise<void> {
    if (syncing) {
      ctx.ui.notify("Model synchronization is already running", "warning");
      return;
    }

    const config = await readRawConfig();
    const providers = (config.providers ??= {});
    try {
      const providerName = name ?? (await promptRequired(ctx, "Provider name", "llama2"));
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(providerName)) {
        ctx.ui.notify("Provider name must be a single word (letters, digits, - or _)", "error");
        return;
      }
      if (providers[providerName]) {
        ctx.ui.notify(`Provider "${providerName}" already exists — use /provider edit ${providerName}`, "warning");
        return;
      }

      const baseUrl = await promptRequired(ctx, `Base URL (${providerName})`, "http://192.168.1.10:8888/v1");
      const problem = baseUrlProblem(baseUrl);
      if (problem) {
        ctx.ui.notify(problem, "error");
        return;
      }
      const apiKey = await promptRequired(ctx, `API key (${providerName})`, "sk-...");

      providers[providerName] = {
        api: "openai-completions",
        baseUrl,
        apiKey,
        compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
        models: [],
      };
      await writeRawConfig(config);
      ctx.ui.notify(`Provider "${providerName}" added`, "info");
      if (!(await syncOne(providerName, ctx))) {
        ctx.ui.notify(`Provider "${providerName}" is in models.json with no models yet`, "warning");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(message, message === "Setup cancelled" ? "warning" : "error");
    }
  }

  async function editProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext, name?: string): Promise<void> {
    if (syncing) {
      ctx.ui.notify("Model synchronization is already running", "warning");
      return;
    }

    const config = await readRawConfig();
    const providers = config.providers ?? {};
    const names = Object.keys(providers);
    if (names.length === 0) {
      ctx.ui.notify("No providers in models.json — use /provider add", "warning");
      return;
    }

    let providerName = name && providers[name] ? name : undefined;
    if (!providerName) {
      providerName = await ctx.ui.select("Edit which provider?", names);
      if (!providerName) {
        ctx.ui.notify("Edit cancelled", "warning");
        return;
      }
    }

    const provider = providers[providerName];
    try {
      const baseUrl = await promptKeep(ctx, `Base URL (${providerName})`, provider.baseUrl ?? "http://192.168.1.10:8888/v1");
      const problem = baseUrlProblem(baseUrl);
      if (problem) {
        ctx.ui.notify(problem, "error");
        return;
      }
      const apiKey = await promptKeep(ctx, `API key (${providerName})`, provider.apiKey ?? "");
      if (!apiKey) {
        ctx.ui.notify("An API key is required", "error");
        return;
      }

      provider.baseUrl = baseUrl;
      provider.apiKey = apiKey;
      await writeRawConfig(config);
      ctx.ui.notify(`Provider "${providerName}" updated`, "info");
      await syncOne(providerName, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(message, message === "Setup cancelled" ? "warning" : "error");
    }
  }

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    // Fire-and-forget so startup is not blocked by the server fetch.
    // When several models are resident this prompts to pick one.
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

  pi.registerCommand("provider", {
    description: "List, add or edit providers in models.json (add/edit syncs that provider and reloads Pi)",
    getArgumentCompletions: async (prefix) => {
      const text = prefix.trim().toLowerCase();
      let names: string[] = [];
      try {
        names = Object.keys((await readRawConfig()).providers ?? {});
      } catch {
        // malformed models.json — only offer the subcommands
      }
      const options = [
        { value: "add", label: "add", description: "Add a new provider" },
        ...names.map((name) => ({ value: `edit ${name}`, label: `edit ${name}`, description: `Edit "${name}"` })),
      ];
      const matches = options.filter((option) => option.value.startsWith(text));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const [subcommand = "list", ...rest] = args.trim().split(/\s+/);
      if (subcommand === "list") await listProviders(ctx);
      else if (subcommand === "add") await addProvider(pi, ctx, rest[0]);
      else if (subcommand === "edit") await editProvider(pi, ctx, rest[0]);
      else ctx.ui.notify("Usage: /provider [list | add [name] | edit [name]]", "error");
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
      const commonArgs = argument === "all" ? ["--include-all"] : [];

      let runs: Array<{ name: string; args: string[] }>;
      try {
        const config = await readModelsConfig();
        const providers: Array<[string, ProviderConfig | undefined]> = Object.entries(config.providers ?? {});
        // A config with no providers yet gets one prompted provider.
        if (providers.length === 0) providers.push([await promptRequired(ctx, "Provider name", "llama"), undefined]);

        runs = [];
        for (const [name, provider] of providers) {
          const args = [...commonArgs];
          if (!provider?.baseUrl) {
            const ip = await promptRequired(ctx, `Server IP or hostname (${name})`, "192.168.1.10");
            const port = await promptRequired(ctx, `Server port (${name})`, "8888");
            const portNumber = Number(port);
            if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
              throw new Error("Server port must be between 1 and 65535");
            }
            args.push("--ip", ip, "--port", String(portNumber));
          }
          if (!provider?.apiKey) args.push("--api-key", await promptRequired(ctx, `API key (${name})`, "sk-..."));
          runs.push({ name, args });
        }
      } catch (error) {
        syncing = false;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, message === "Setup cancelled" ? "warning" : "error");
        return;
      }

      ctx.ui.notify("Synchronizing models…", "info");

      const synced: string[] = [];
      const failed: string[] = [];
      for (const run of runs) {
        try {
          synced.push(await syncProvider(pi, run.name, run.args));
        } catch (error) {
          failed.push(`${run.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      syncing = false;
      await reloadAfterSync(ctx, synced, failed);
    },
  });
}
