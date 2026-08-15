import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];
const EXTENSION_AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = resolve(process.env.PI_CODING_AGENT_DIR ?? EXTENSION_AGENT_DIR);
const BUDGET_STORE_PATH = resolve(AGENT_DIR, "reasoning-budgets.json");
const REASONING_BUDGET_FLAG = "--reasoning-budget";

interface BudgetStore {
  version: 1;
  budgets: Record<string, number>;
}

interface InferenceStatus {
  active_model?: string | null;
  model_identifier?: string | null;
  is_gguf?: boolean;
  gguf_variant?: string | null;
  requested_context_length?: number | null;
  context_length?: number | null;
  cache_type_kv?: string | null;
  requested_gpu_ids?: number[] | null;
  speculative_type?: string | null;
  spec_draft_n_max?: number | null;
  tensor_parallel?: boolean;
  gpu_memory_mode?: "auto" | "manual";
  gpu_layers?: number;
  cpu_fallback_reason?: string | null;
  n_cpu_moe?: number;
  tensor_split?: number[] | null;
  requested_parallel_slots?: number | null;
  requested_n_batch?: number | null;
  requested_n_ubatch?: number | null;
  requested_llama_extra_args?: string[] | null;
  chat_template_override?: string | null;
}

const ALIASES: Record<string, ThinkingLevel> = {
  off: "off",
  none: "off",
  0: "off",
  min: "minimal",
  minimal: "minimal",
  1: "minimal",
  low: "low",
  2: "low",
  med: "medium",
  medium: "medium",
  3: "medium",
  hi: "high",
  high: "high",
  4: "high",
  xhigh: "xhigh",
  max: "xhigh",
  maximum: "xhigh",
  5: "xhigh",
};

function normalizeLevel(input: string): ThinkingLevel | undefined {
  return ALIASES[input.trim().toLowerCase()];
}

function usage(current: ThinkingLevel): string {
  return `Current effort: ${current}. Usage: /effort <${LEVELS.join("|")}> (aliases: min, med, max, 0-5)`;
}

function modelKey(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

async function loadBudgetStore(): Promise<BudgetStore> {
  try {
    const parsed = JSON.parse(await readFile(BUDGET_STORE_PATH, "utf8")) as Partial<BudgetStore>;
    if (parsed.version !== 1 || typeof parsed.budgets !== "object" || parsed.budgets === null) {
      throw new Error("expected version 1 with a budgets object");
    }
    return { version: 1, budgets: parsed.budgets as Record<string, number> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, budgets: {} };
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${BUDGET_STORE_PATH}: ${message}`);
  }
}

async function saveBudgetStore(store: BudgetStore): Promise<void> {
  await mkdir(dirname(BUDGET_STORE_PATH), { recursive: true });
  const temporaryPath = `${BUDGET_STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, BUDGET_STORE_PATH);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function readReasoningBudget(args: string[] | null | undefined): number | undefined {
  if (!args) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === REASONING_BUDGET_FLAG) {
      const budget = Number(args[index + 1]);
      return Number.isInteger(budget) && budget > 0 ? budget : undefined;
    }
    if (args[index].startsWith(`${REASONING_BUDGET_FLAG}=`)) {
      const budget = Number(args[index].slice(REASONING_BUDGET_FLAG.length + 1));
      return Number.isInteger(budget) && budget > 0 ? budget : undefined;
    }
  }
  return undefined;
}

function mergeReasoningBudget(args: string[] | null | undefined, budget: number): string[] {
  const merged: string[] = [];
  for (let index = 0; index < (args?.length ?? 0); index += 1) {
    const argument = args![index];
    if (argument === REASONING_BUDGET_FLAG) {
      index += 1;
      continue;
    }
    if (argument.startsWith(`${REASONING_BUDGET_FLAG}=`)) continue;
    merged.push(argument);
  }
  merged.push(REASONING_BUDGET_FLAG, String(budget));
  return merged;
}

function studioUrl(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/, "") + pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function requestContext(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.model) throw new Error("No active model");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) throw new Error(auth.error);
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") headers.set(name, value);
  }
  if (auth.apiKey && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${auth.apiKey}`);
  return { baseUrl: auth.baseUrl ?? ctx.model.baseUrl, headers };
}

async function fetchInferenceStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<InferenceStatus> {
  const request = await requestContext(pi, ctx);
  const response = await fetch(studioUrl(request.baseUrl, "/api/inference/status"), {
    headers: request.headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Inference status failed: HTTP ${response.status}`);
  return await response.json() as InferenceStatus;
}

function copyIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value;
}

function buildLoadRequest(status: InferenceStatus, budget: number): Record<string, unknown> {
  const modelPath = status.model_identifier ?? status.active_model;
  if (!modelPath) throw new Error("Server did not report the active model identifier");
  const request: Record<string, unknown> = {
    model_path: modelPath,
    max_seq_length: status.requested_context_length ?? status.context_length ?? 0,
    llama_extra_args: mergeReasoningBudget(status.requested_llama_extra_args, budget),
    force_cancel_active: false,
  };
  copyIfPresent(request, "gguf_variant", status.gguf_variant);
  copyIfPresent(request, "chat_template_override", status.chat_template_override);
  copyIfPresent(request, "cache_type_kv", status.cache_type_kv);
  copyIfPresent(request, "gpu_ids", status.requested_gpu_ids);
  copyIfPresent(request, "speculative_type", status.speculative_type);
  copyIfPresent(request, "spec_draft_n_max", status.spec_draft_n_max);
  copyIfPresent(request, "tensor_parallel", status.tensor_parallel);
  copyIfPresent(request, "gpu_memory_mode", status.gpu_memory_mode);
  copyIfPresent(request, "gpu_layers", status.gpu_layers);
  copyIfPresent(request, "n_cpu_moe", status.n_cpu_moe);
  copyIfPresent(request, "tensor_split", status.tensor_split);
  copyIfPresent(request, "n_parallel", status.requested_parallel_slots);
  copyIfPresent(request, "n_batch", status.requested_n_batch);
  copyIfPresent(request, "n_ubatch", status.requested_n_ubatch);
  if (status.cpu_fallback_reason) request.cpu_fallback = true;
  return request;
}

async function applyReasoningBudget(pi: ExtensionAPI, ctx: ExtensionContext, budget: number): Promise<void> {
  if (!ctx.model) throw new Error("No active model");
  const status = await fetchInferenceStatus(pi, ctx);
  if (!status.is_gguf) throw new Error("The active server model is not a GGUF model");
  const activeModel = status.model_identifier ?? status.active_model;
  if (activeModel !== ctx.model.id) {
    throw new Error(`Server model ${activeModel ?? "unknown"} does not match Pi model ${ctx.model.id}`);
  }

  const request = await requestContext(pi, ctx);
  const response = await fetch(studioUrl(request.baseUrl, "/api/inference/load"), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(buildLoadRequest(status, budget)),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`Model reload failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

export default function effortExtension(pi: ExtensionAPI) {
  const notifiedModels = new Set<string>();

  const notifyMissingBudget = async (ctx: ExtensionContext) => {
    const key = modelKey(ctx);
    if (!key || notifiedModels.has(key)) return;
    try {
      const desired = (await loadBudgetStore()).budgets[key];
      if (!desired) return;
      const status = await fetchInferenceStatus(pi, ctx);
      const activeModel = status.model_identifier ?? status.active_model;
      if (activeModel !== ctx.model?.id) return;
      if (readReasoningBudget(status.requested_llama_extra_args) === desired) {
        notifiedModels.delete(key);
        return;
      }
      notifiedModels.add(key);
      ctx.ui.notify(`Reasoning budget ${desired} is not active for ${ctx.model.id}; run /reasoning-budget apply`, "warning");
    } catch (error) {
      console.error(`[effort] budget status check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  pi.on("session_start", async (_event, ctx) => notifyMissingBudget(ctx));
  pi.on("model_select", async (_event, ctx) => notifyMissingBudget(ctx));

  pi.registerCommand("effort", {
    description: "Set reasoning effort or fully disable thinking with off",
    getArgumentCompletions: (prefix: string) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      const completions = LEVELS
        .filter((level) => level.startsWith(normalizedPrefix))
        .map((level) => ({ value: level, label: level }));

      return completions.length > 0 ? completions : null;
    },
    handler: async (args, ctx) => {
      let requested: ThinkingLevel | undefined;

      if (args.trim()) {
        requested = normalizeLevel(args);
        if (!requested) {
          ctx.ui.notify(`Unknown effort: ${args.trim()}. ${usage(pi.getThinkingLevel() as ThinkingLevel)}`, "error");
          return;
        }
      } else if (ctx.hasUI) {
        const current = pi.getThinkingLevel() as ThinkingLevel;
        const choice = await ctx.ui.select(
          `Set effort (current: ${current})`,
          LEVELS.map((level) => (level === current ? `${level} (current)` : level)),
        );
        if (!choice) return;
        requested = choice.replace(" (current)", "") as ThinkingLevel;
      } else {
        ctx.ui.notify(usage(pi.getThinkingLevel() as ThinkingLevel), "info");
        return;
      }

      const previous = pi.getThinkingLevel() as ThinkingLevel;
      pi.setThinkingLevel(requested);
      const effective = pi.getThinkingLevel() as ThinkingLevel;

      if (effective !== requested) {
        const message = `Effort ${requested} is unsupported by this model; using ${effective}`;
        ctx.ui.notify(message, requested === "off" ? "error" : "warning");
        return;
      }

      const suffix = effective === "off" ? " (reasoning disabled)" : "";
      ctx.ui.notify(`Effort: ${previous} → ${effective}${suffix}`, "info");
    },
  });

  pi.registerCommand("reasoning-budget", {
    description: "Manage the active GGUF model's server-side reasoning budget",
    getArgumentCompletions: (prefix) => {
      const options = ["status", "apply", "8192", "clear"];
      const normalizedPrefix = prefix.trim().toLowerCase();
      const matches = options
        .filter((option) => option.startsWith(normalizedPrefix))
        .map((option) => ({ value: option, label: option }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const key = modelKey(ctx);
      if (!key || !ctx.model) {
        ctx.ui.notify("No active model", "error");
        return;
      }

      const argument = args.trim().toLowerCase() || "status";
      try {
        const store = await loadBudgetStore();
        if (argument === "clear") {
          const previous = store.budgets[key];
          delete store.budgets[key];
          await saveBudgetStore(store);
          notifiedModels.delete(key);
          const suffix = previous ? `; active server budget ${previous} remains until the next model reload` : "";
          ctx.ui.notify(`Cleared saved reasoning budget for ${key}${suffix}`, "info");
          return;
        }

        if (argument === "status") {
          const desired = store.budgets[key];
          const status = await fetchInferenceStatus(pi, ctx);
          const active = readReasoningBudget(status.requested_llama_extra_args);
          ctx.ui.notify(`Reasoning budget for ${key}: saved=${desired ?? "none"}, active=${active ?? "none"}`, "info");
          return;
        }

        const budget = argument === "apply" ? store.budgets[key] : Number(argument);
        if (!Number.isInteger(budget) || budget < 1 || budget > 131_072) {
          ctx.ui.notify("Usage: /reasoning-budget [status|apply|clear|<1-131072>]", "error");
          return;
        }
        if (argument === "apply" && !store.budgets[key]) {
          ctx.ui.notify(`No saved reasoning budget for ${key}`, "error");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("Applying a reasoning budget requires interactive confirmation", "error");
          return;
        }

        await ctx.waitForIdle();
        const confirmed = await ctx.ui.confirm(
          "Reload active model?",
          `Apply an ${budget}-token reasoning budget to ${ctx.model.id}? This clears the server KV cache.`,
        );
        if (!confirmed) return;

        store.budgets[key] = budget;
        await saveBudgetStore(store);
        ctx.ui.notify(`Reloading ${ctx.model.id} with reasoning budget ${budget}…`, "info");
        await applyReasoningBudget(pi, ctx, budget);
        notifiedModels.delete(key);
        ctx.ui.notify(`Reasoning budget ${budget} is active for ${ctx.model.id}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });
}
