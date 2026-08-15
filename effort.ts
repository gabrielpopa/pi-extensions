import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];

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

export default function effortExtension(pi: ExtensionAPI) {
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
}
