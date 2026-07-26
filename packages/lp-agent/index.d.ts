/**
 * Conservative TypeScript declarations for Next.js imports of @orloj/lp-agent.
 * Trace fields are intentionally loose — prefer runtime audit JSON over duplicating every shape.
 */

export type AgentMode = "observe" | "execute";

export interface LpAgentConfig {
  orlojMcpUrl: string;
  orlojMcpApiKey: string;
  theGraphApiKey: string;
  subgraphId: string;
  graphGatewayBase: string;
  graphUrl: string;
  aiChatCompletionsUrl: string;
  aiApiKey: string;
  aiModel: string;
  agentMode: AgentMode;
  nftTokenId: string | null;
  chainId: string;
  stateFilePath: string;
  allowCreateRetry: boolean;
  allowCreateRetryCycleId: string | null;
}

export interface RunOnceDeps {
  config?: LpAgentConfig;
  [key: string]: unknown;
}

export interface RunOnceResult {
  status: "ok" | "partial" | "error";
  phase?: number;
  agentMode?: AgentMode;
  discovery?: unknown;
  results?: unknown[];
  message?: string;
  error?: string;
  [key: string]: unknown;
}

export declare const DEFAULT_CHAIN_ID: string;
export declare const DEFAULT_SUBGRAPH_ID: string;
export declare const DEFAULT_STATE_FILE: string;
export declare const LP_MANAGER_MCP_ID: string;
export declare const ANALYZE_TOOL: string;
export declare const MANAGE_TOOL: string;

export declare function loadConfig(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): LpAgentConfig;

export declare function runOnce(deps?: RunOnceDeps): Promise<RunOnceResult>;

export declare function safeAgentStateKey(agentId: string): string;
export declare function stateFilePathForAgent(
  stateDir: string,
  agentId: string,
): string;

export interface TrustedChatBridgeInput {
  agentId: string;
  agentMode: AgentMode;
  orlojMcpUrl: string;
  orlojBearerToken: string;
  theGraphApiKey: string;
  aiChatCompletionsUrl: string;
  aiApiKey: string;
  aiModel: string;
  stateDir: string;
  subgraphId?: string;
  graphGatewayBase?: string;
}

export declare function buildTrustedChatConfig(
  input: TrustedChatBridgeInput,
): LpAgentConfig;

export declare function acquireAgentCycleLock(agentId: string): () => void;
export declare function resetAgentCycleLocksForTests(): void;

export interface LpAgentMcpDispatcherOptions {
  agentId: string;
  buildConfig: (
    mode: AgentMode,
  ) =>
    | Omit<TrustedChatBridgeInput, "agentId" | "agentMode">
    | Promise<Omit<TrustedChatBridgeInput, "agentId" | "agentMode">>;
  runOnceFn?: (deps?: RunOnceDeps) => Promise<RunOnceResult>;
  executeEnabled?: boolean;
}

export interface LpAgentMcpDispatcher {
  dispatch: (body: unknown) => Promise<object | null>;
  listTools: () => object[];
}

export declare function createLpAgentMcpDispatcher(
  options: LpAgentMcpDispatcherOptions,
): LpAgentMcpDispatcher;
