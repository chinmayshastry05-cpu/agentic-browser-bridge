/**
 * Shared types for the Agentic Browser bridge.
 * Original implementation — no third-party "agentic browser" code is reused here.
 */

/** A single interactable (or structurally interesting) DOM element, as seen by the agent. */
export interface DomNode {
  /** Stable short reference used by tools, e.g. "e12". Assigned per snapshot. */
  ref: string;
  /** ARIA-ish role: button, link, textbox, heading, ... */
  role: string;
  /** Accessible name (aria-label / text / alt / placeholder), trimmed. */
  name: string;
  /** Lowercase tag name. */
  tag: string;
  /** Visible text content for text-ish roles (may be empty). */
  text?: string;
  /** Subset of attributes worth exposing (type, href, placeholder, value, ...). */
  attributes: Record<string, string>;
  /** Unique CSS selector usable to re-locate this element for actions. */
  selector: string;
  /** Parent element ref, or null for roots. */
  parentRef: string | null;
  /** Child element refs (same snapshot). */
  childrenRefs: string[];
  /** Viewport bounding box, if measurable. */
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  /** Whether the element is rendered and not hidden. */
  visible: boolean;
}

/** A point-in-time capture of a page. */
export interface PageSnapshot {
  url: string;
  title: string;
  capturedAt: string; // ISO timestamp
  nodes: DomNode[];
}

/** Actions the agent loop can emit. */
export type ActionName =
  | 'navigate'
  | 'click'
  | 'type'
  | 'screenshot'
  | 'snapshot'
  | 'finish'
  | 'noop';

export interface AgentAction {
  action: ActionName;
  /** Element ref for click/type. */
  ref?: string;
  /** URL for navigate. */
  url?: string;
  /** Text for type. */
  text?: string;
  /** Optional submit (press Enter) after typing. */
  submit?: boolean;
  /** Free-text rationale from the planner. */
  reason?: string;
  /** Set by the planner when the goal is achieved. */
  result?: string;
}

/** Outcome of a single tool call or agent step. */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** One executed step of the agent loop. */
export interface StepRecord {
  step: number;
  action: AgentAction;
  result: ToolResult;
  startedAt: string;
  finishedAt: string;
}

/** Full trace of an agent run. */
export interface AgentTrace {
  goal: string;
  steps: StepRecord[];
  finished: boolean;
  finishReason?: string;
  startedAt: string;
  finishedAt: string;
}

/** Backend-agnostic browser automation contract. Swap Playwright for something
 *  else by implementing this interface; the session layer never imports Playwright. */
export interface BrowserBackend {
  start(opts: BrowserStartOptions): Promise<void>;
  stop(): Promise<void>;
  goto(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string, submit: boolean): Promise<void>;
  screenshot(path: string): Promise<void>;
  currentUrl(): string;
  title(): Promise<string>;
}

export interface BrowserStartOptions {
  headless: boolean;
  viewport?: { width: number; height: number };
  navigationTimeoutMs?: number;
}

/** LLM provider contract — pluggable, key always comes from the environment. */
export interface LLMProvider {
  readonly name: string;
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** JSON-RPC 2.0 shapes used by the bridge server. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
