import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PromptMode = "append" | "replace";

interface ModelPrompt {
  mode: PromptMode;
  prompt: string;
}

interface ModelPromptStore {
  version: 1;
  prompts: Record<string, ModelPrompt>;
}

const EXTENSION_AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = resolve(process.env.PI_CODING_AGENT_DIR ?? EXTENSION_AGENT_DIR);
const STORE_PATH = resolve(AGENT_DIR, "model-prompts.json");
const EMPTY_STORE: ModelPromptStore = { version: 1, prompts: {} };

function modelKey(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

async function loadStore(): Promise<ModelPromptStore> {
  try {
    const parsed = JSON.parse(await readFile(STORE_PATH, "utf8")) as Partial<ModelPromptStore>;
    if (parsed.version !== 1 || typeof parsed.prompts !== "object" || parsed.prompts === null) {
      throw new Error("expected version 1 with a prompts object");
    }
    return { version: 1, prompts: parsed.prompts as Record<string, ModelPrompt> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: EMPTY_STORE.version, prompts: {} };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${STORE_PATH}: ${message}`);
  }
}

async function saveStore(store: ModelPromptStore): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const temporaryPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, STORE_PATH);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function splitCommand(args: string): { command: string; value: string } {
  const trimmed = args.trim();
  const separator = trimmed.indexOf(" ");
  if (separator === -1) return { command: trimmed.toLowerCase(), value: "" };
  return {
    command: trimmed.slice(0, separator).toLowerCase(),
    value: trimmed.slice(separator + 1).trim(),
  };
}

function usage(): string {
  return "Usage: /model-prompt [show|set <prompt>|replace <prompt>|mode <append|replace>|clear]";
}

export default function modelPromptExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const key = modelKey(ctx);
    if (!key) return;

    try {
      const entry = (await loadStore()).prompts[key];
      if (!entry?.prompt) return;
      if (entry.mode === "replace") return { systemPrompt: entry.prompt };
      return { systemPrompt: `${event.systemPrompt}\n\n${entry.prompt}` };
    } catch (error) {
      console.error(`[model-prompt] ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  pi.registerCommand("model-prompt", {
    description: "Set or modify the system prompt for the active model",
    getArgumentCompletions: (prefix) => {
      const options = ["show", "set", "replace", "mode", "clear"];
      const normalizedPrefix = prefix.trim().toLowerCase();
      const matches = options
        .filter((option) => option.startsWith(normalizedPrefix))
        .map((option) => ({ value: option, label: option }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const key = modelKey(ctx);
      if (!key) {
        ctx.ui.notify("No active model", "error");
        return;
      }

      let { command, value } = splitCommand(args);
      if (!command && ctx.hasUI) {
        const choice = await ctx.ui.select(`Model prompt: ${key}`, [
          "show",
          "set (append)",
          "replace",
          "clear",
        ]);
        if (!choice) return;
        command = choice === "set (append)" ? "set" : choice;
      } else if (!command) {
        ctx.ui.notify(usage(), "info");
        return;
      }

      try {
        const store = await loadStore();
        const current = store.prompts[key];

        if (command === "show") {
          if (!current) {
            ctx.ui.notify(`No custom prompt for ${key}`, "info");
            return;
          }
          ctx.ui.notify(`${key} [${current.mode}]\n${current.prompt}`, "info");
          return;
        }

        if (command === "clear") {
          if (!current) {
            ctx.ui.notify(`No custom prompt for ${key}`, "info");
            return;
          }
          delete store.prompts[key];
          await saveStore(store);
          ctx.ui.notify(`Cleared model prompt for ${key}`, "info");
          return;
        }

        if (command === "mode") {
          if (value !== "append" && value !== "replace") {
            ctx.ui.notify("Usage: /model-prompt mode <append|replace>", "error");
            return;
          }
          if (!current) {
            ctx.ui.notify(`No custom prompt for ${key}`, "error");
            return;
          }
          current.mode = value;
          await saveStore(store);
          ctx.ui.notify(`Model prompt mode for ${key}: ${value}`, "info");
          return;
        }

        if (command !== "set" && command !== "replace") {
          ctx.ui.notify(usage(), "error");
          return;
        }

        if (!value && ctx.hasUI) {
          value = (await ctx.ui.input(
            command === "replace" ? "Replacement system prompt" : "Prompt to append",
            current?.prompt ?? "Enter model-specific instructions",
          ))?.trim() ?? "";
        }
        if (!value) {
          ctx.ui.notify(command === "replace" ? "Replacement prompt cannot be empty" : "Prompt cannot be empty", "error");
          return;
        }

        store.prompts[key] = {
          mode: command === "replace" ? "replace" : "append",
          prompt: value,
        };
        await saveStore(store);
        ctx.ui.notify(`Saved ${store.prompts[key].mode} prompt for ${key}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });
}
