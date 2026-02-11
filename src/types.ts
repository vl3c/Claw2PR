export type PluginConfig = {
  ghToken: string;
  gitUserName: string;
  gitUserEmail: string;
  defaultBudget?: number;
  maxConcurrentTasks?: number;
  selfassemblerVenv?: string;
  envFile?: string;
  useSubscriptionAuth?: boolean;
  dockerImage?: string;
  workspaceDir?: string;
};
