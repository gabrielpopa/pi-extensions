import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC_SCRIPT = resolve(AGENT_DIR, "sync-models.py");
const MODELS_CONFIG = resolve(AGENT_DIR, "models.json");

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
      ctx.ui.notify("Synchronizing models…", "info");

      const scriptArgs = [SYNC_SCRIPT, "--config", MODELS_CONFIG];
      if (argument === "all") scriptArgs.push("--include-all");

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

      syncing = false;
      const firstLine = result.stdout.trim().split("\n")[0];
      ctx.ui.notify(firstLine || "Models synchronized; reloading Pi", "info");
      await ctx.reload();
      return;
    },
  });
}
