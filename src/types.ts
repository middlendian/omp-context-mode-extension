/**
 * OMP Extension API type stubs.
 *
 * Derived from oh-my-pi docs/extensions.md and
 * packages/coding-agent/src/extensibility/extensions/types.ts.
 * These are ambient declarations — OMP injects the real runtime objects.
 */

// ---------------------------------------------------------------------------
// UI context
// ---------------------------------------------------------------------------

export interface ExtensionUIContext {
  notify(message: string, opts?: { type?: "info" | "success" | "error" | "warning" }): void;
  setStatus(message: string): void;
  setTitle(title: string): void;
  select<T extends string>(prompt: string, choices: T[]): Promise<T | undefined>;
  confirm(prompt: string): Promise<boolean>;
  input(prompt: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Session manager (read-only)
// ---------------------------------------------------------------------------

export interface SessionEntry {
  id: string;
  type: string;
  data: unknown;
  timestamp: number;
}

export interface SessionManager {
  getBranch(): SessionEntry[];
  getSessionId(): string;
}

// ---------------------------------------------------------------------------
// Handler context (passed to every event handler)
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  /** Current working directory / project root */
  cwd: string;
  ui: ExtensionUIContext;
  sessionManager: SessionManager;
  model: string;
  getContextUsage(): { used: number; max: number };
  compact(): Promise<void>;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  shutdown(): void;
  getSystemPrompt(): string;
  hasUI: boolean;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
  newSession(): Promise<void>;
  switchSession(id: string): Promise<void>;
  branch(entryId: string): Promise<void>;
  navigateTree(targetId: string): Promise<void>;
  reload(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Message delivery
// ---------------------------------------------------------------------------

export type DeliverAs = "steer" | "followUp" | "nextTurn";

export interface SendMessageOptions {
  deliverAs?: DeliverAs;
  triggerTurn?: boolean;
  role?: "user" | "assistant";
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export interface AgentToolResult {
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  details?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema or TypeBox schema for parameters */
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (partial: string) => void,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult>;
  /** Called on session lifecycle events (optional) */
  onSession?(event: SessionLifecycleEvent, ctx: ExtensionContext): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export type SessionType = "startup" | "compact" | "resume" | "clear";

export interface SessionStartEvent {
  sessionType: SessionType;
  sessionId?: string;
}

export interface SessionCompactEvent {
  sessionId?: string;
  reason?: string;
}

export interface SessionSwitchEvent {
  fromSessionId?: string;
  toSessionId?: string;
}

export interface SessionBranchEvent {
  fromEntryId?: string;
  sessionId?: string;
}

export interface SessionShutdownEvent {
  sessionId?: string;
}

export type SessionLifecycleEvent =
  | SessionStartEvent
  | SessionCompactEvent
  | SessionSwitchEvent
  | SessionBranchEvent
  | SessionShutdownEvent;

export interface InputEvent {
  text: string;
  sessionId?: string;
}

// Generic tool call — OMP also emits typed variants per tool
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
}

// Return from a pre-tool handler to block or modify execution
export type ToolCallDecision =
  | { cancel: true; message: string }
  | { modify: Record<string, unknown> }
  | { context: string }
  | void
  | undefined;

export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  result: AgentToolResult;
}

// Return from a post-tool handler to override the result seen by the model
export type ToolResultDecision = AgentToolResult | void | undefined;

export interface ContextEvent {
  /** Append additional context by returning a string */
  existingContext?: string;
}

export interface AgentStartEvent {
  sessionId?: string;
}

export interface AgentEndEvent {
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Extension API
// ---------------------------------------------------------------------------

type HandlerFn<TEvent, TReturn = void | Promise<void>> = (
  event: TEvent,
  ctx: ExtensionContext,
) => TReturn;

export interface ExtensionAPI {
  // --- event subscriptions ---
  on(event: "session_start", handler: HandlerFn<SessionStartEvent>): void;
  on(event: "session_before_compact", handler: HandlerFn<SessionCompactEvent>): void;
  on(event: "session_compact", handler: HandlerFn<SessionCompactEvent>): void;
  on(event: "session_before_switch", handler: HandlerFn<SessionSwitchEvent>): void;
  on(event: "session_switch", handler: HandlerFn<SessionSwitchEvent>): void;
  on(event: "session_before_branch", handler: HandlerFn<SessionBranchEvent>): void;
  on(event: "session_branch", handler: HandlerFn<SessionBranchEvent>): void;
  on(event: "session_shutdown", handler: HandlerFn<SessionShutdownEvent>): void;
  on(event: "input", handler: HandlerFn<InputEvent>): void;
  on(
    event: "tool_call",
    handler: HandlerFn<ToolCallEvent, ToolCallDecision | Promise<ToolCallDecision>>,
  ): void;
  on(
    event: "tool_result",
    handler: HandlerFn<ToolResultEvent, ToolResultDecision | Promise<ToolResultDecision>>,
  ): void;
  on(event: "context", handler: HandlerFn<ContextEvent, string | void | Promise<string | void>>): void;
  on(event: "agent_start", handler: HandlerFn<AgentStartEvent>): void;
  on(event: "agent_end", handler: HandlerFn<AgentEndEvent>): void;
  on(event: string, handler: HandlerFn<unknown>): void;

  // --- registration ---
  registerTool(definition: ToolDefinition): void;
  registerCommand(
    name: string,
    opts: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void> },
  ): void;

  // --- message injection ---
  sendMessage(message: string, opts?: SendMessageOptions): void;
  sendUserMessage(message: string, opts?: SendMessageOptions): void;
  appendEntry(type: string, data: unknown): void;

  // --- model control ---
  setModel(model: string): void;
  getThinkingLevel(): number;
  setThinkingLevel(level: number): void;

  // --- tool management ---
  getActiveTools(): string[];
  setActiveTools(tools: string[]): void;

  // --- utilities ---
  logger: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
  };
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
