import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

async function qwenThinkingIsValid(): Promise<boolean> {
  const config = await readModelsConfig();
  const qwenModels = Object.values(config.providers ?? {}).flatMap((provider) =>
    (provider.models ?? []).filter((model) => model.id?.toLowerCase().includes("qwen3.8-27b"))
  );
  return qwenModels.length === 0 || qwenModels.every((model) =>
    model.samplingParams?.chat_template_kwargs?.preserve_thinking === true
  );
}

export default function (pi: ExtensionAPI) {
  let syncing = false;

  pi.registerCommand("sync-models", {
    description: "Pull the latest server models into models.json and reload Pi",
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
        ctx.ui.notify("Model synchronization failed: Qwen3.8 preserve_thinking was not enabled", "error");
        return;
      }

      syncing = false;
      const firstLine = result.stdout.trim().split("\n")[0];
      ctx.ui.notify(firstLine || "Models synchronized; reloading Pi", "info");
      await ctx.reload();
      return;
    },
  });
}
