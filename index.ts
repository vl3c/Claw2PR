import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { TaskStore } from "./src/task-store.js";
import { createCodingTools } from "./src/tools.js";

type PluginConfig = {
  ghToken: string;
  gitUserName: string;
  gitUserEmail: string;
  defaultBudget?: number;
  maxConcurrentTasks?: number;
  selfassemblerVenv?: string;
  envFile?: string;
  useSubscriptionAuth?: boolean;
};

const plugin = {
  id: "coding-tool",
  name: "Coding Tool",
  description: "Autonomous coding tasks — clone repos, run SelfAssembler through GritGuard, produce PRs",

  register(api: OpenClawPluginApi) {
    const rawConfig = (api.pluginConfig ?? {}) as PluginConfig;
    const config: PluginConfig = {
      ...rawConfig,
      ghToken: rawConfig.ghToken || process.env.GH_TOKEN || "",
    };

    if (!config.ghToken) {
      console.log("[coding-tool] Warning: ghToken not configured — tasks will fail until configured");
    }

    // Read hook token from openclaw config for notifications
    let hookToken = "";
    try {
      const fullConfig = api.runtime.config.loadConfig() as Record<string, unknown>;
      const hooks = (fullConfig as any)?.hooks;
      if (hooks?.token) hookToken = hooks.token;
    } catch (e) {
      console.log(`[coding-tool] Warning: could not read hook token: ${e}`);
    }

    // Determine plugin directory
    let pluginDir: string;
    try {
      pluginDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
    } catch {
      pluginDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
    }
    const workspaceDir = "/var/lib/openclaw/.openclaw/workspace/coding-tasks";

    // Initialize task store and reconcile
    const store = new TaskStore(workspaceDir);
    store.reconcile();

    // Register tools
    const tools = createCodingTools(config, store, pluginDir, hookToken);
    for (const tool of tools) {
      api.registerTool(tool);
    }

    console.log(`[coding-tool] Coding Tool plugin registered (${tools.length} tools)`);
  },
};

export default plugin;
