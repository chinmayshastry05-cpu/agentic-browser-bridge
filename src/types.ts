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
  /**
   * Frame context for the node. Undefined for top-frame nodes; set to a
   * frame id for nodes captured inside an iframe / shadow scope.
   */
  frameId?: string;
}

/** A point-in-time capture of a page. */
export interface PageSnapshot {
  /** Unique id for this snapshot; refs are only valid within it. */
  snapshotId: string;
  url: string;
  title: string;
  capturedAt: string; // ISO timestamp
  nodes: DomNode[];
}

/** Actions the agent loop can emit. */
export type ActionName =
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'click'
  | 'double_click'
  | 'type'
  | 'clear'
  | 'press_key'
  | 'select_option'
  | 'check'
  | 'scroll'
  | 'wait_for'
  | 'screenshot'
  | 'snapshot'
  | 'finish'
  | 'noop';

export interface AgentAction {
  action: ActionName;
  /** Element ref for click/type/... */
  ref?: string;
  /** URL for navigate. */
  url?: string;
  /** Text for type. */
  text?: string;
  /** Optional submit (press Enter) after typing. */
  submit?: boolean;
  /** Key for press_key, e.g. "Enter". */
  key?: string;
  /** Values for select_option. */
  values?: string[];
  /** Desired state for check. */
  checked?: boolean;
  /** Scroll delta for scroll. */
  dx?: number;
  dy?: number;
  /** CSS selector for wait_for. */
  selector?: string;
  /** Free-text rationale from the planner. */
  reason?: string;
  /** Set by the planner when the goal is achieved. */
  result?: string;
}

/** Outcome of verifying an action's effect on the page. */
export interface ActionVerification {
  verified: boolean;
  /** How verification was performed, e.g. "url-match", "field-value". */
  method: string;
  detail: string;
}

/** Terminal states of an agent run. */
export type AgentStatus =
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'awaiting_confirmation'
  | 'awaiting_user_input';

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
  /** What verification of the action's effect found (when applicable). */
  verification?: ActionVerification;
  /** How many recovery retries this step needed. */
  recoveryAttempts?: number;
  startedAt: string;
  finishedAt: string;
}

/** Full trace of an agent run. */
export interface AgentTrace {
  goal: string;
  steps: StepRecord[];
  finished: boolean;
  status: AgentStatus;
  finishReason?: string;
  startedAt: string;
  finishedAt: string;
}

/** Backend-agnostic browser automation contract. Swap Playwright for something
 *  else by implementing this interface; the session layer never imports Playwright.
 *
 *  Backends come in two flavours:
 *   - launched: start() launches a fresh browser the bridge owns (testing/demo).
 *   - attached: attach() connects to an already-running user browser over CDP.
 *     The user explicitly starts the browser with remote debugging enabled;
 *     the bridge never attaches silently to arbitrary processes.
 */
export interface BrowserBackend {
  readonly backendName: string;
  start(opts: BrowserStartOptions): Promise<void>;
  stop(): Promise<void>;
  /** Attach to an existing browser over CDP. Throws if unsupported. */
  attach(opts: BrowserAttachOptions): Promise<void>;
  /** True after start() or attach() has succeeded. */
  readonly connected: boolean;
  /** True when this backend drives a user-owned browser (attached), false when launched. */
  readonly isUserBrowser: boolean;
  goto(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  listTabs(): Promise<TabInfo[]>;
  openTab(url?: string): Promise<TabInfo>;
  switchTab(tabId: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<void>;
  activeTab(): Promise<TabInfo>;
  snapshot(): Promise<PageSnapshot>;
  click(selector: string, frameId?: string): Promise<void>;
  dblclick(selector: string, frameId?: string): Promise<void>;
  type(selector: string, text: string, submit: boolean, frameId?: string): Promise<void>;
  /** Clear an editable field (no text argument — never used for secrets). */
  clear(selector: string, frameId?: string): Promise<void>;
  pressKey(key: string, frameId?: string): Promise<void>;
  hover(selector: string, frameId?: string): Promise<void>;
  focus(selector: string, frameId?: string): Promise<void>;
  scrollIntoView(selector: string, frameId?: string): Promise<void>;
  selectOption(selector: string, values: string[], frameId?: string): Promise<string[]>;
  setChecked(selector: string, checked: boolean, frameId?: string): Promise<void>;
  /** Scroll the viewport by a delta, or scroll to top/bottom. */
  scrollBy(dx: number, dy: number): Promise<void>;
  /** Wait for a selector to reach a state ("visible"|"hidden"|"attached"). */
  waitForSelector(selector: string, state: 'visible' | 'hidden' | 'attached', timeoutMs: number, frameId?: string): Promise<void>;
  /** Visible text of the page, or of one element. */
  pageText(selector?: string, frameId?: string): Promise<string>;
  /** URL/title/meta description of the active page. */
  pageInfo(): Promise<PageInfo>;
  /** Frames (iframes) in the active page. */
  listFrames(): Promise<FrameInfo[]>;
  /** Snapshot scoped to one frame; refs carry that frame's id. */
  frameSnapshot(frameId: string): Promise<PageSnapshot>;
  /**
   * Describe the live element currently behind a selector (for staleness
   * checks). Returns null when nothing resolves.
   */
  describeTarget(selector: string, frameId?: string): Promise<TargetDescription | null>;
  /**
   * Upload a local file through a file input. The path must be absolute and
   * exist; the caller (policy layer) is responsible for user approval.
   */
  uploadFile(selector: string, filePath: string, frameId?: string): Promise<void>;
  /** Downloads observed since session start (or since last call with consume=true). */
  recentDownloads(consume: boolean): Promise<DownloadRecord[]>;
  /** Wait for the next download to complete. Throws on timeout. */
  waitForDownload(timeoutMs: number): Promise<DownloadRecord>;
  screenshot(path: string): Promise<void>;
  currentUrl(): string;
  title(): Promise<string>;
}

export interface BrowserStartOptions {
  headless: boolean;
  viewport?: { width: number; height: number };
  navigationTimeoutMs?: number;
}

/** Options for attaching to an existing user browser over CDP. */
export interface BrowserAttachOptions {
  /** CDP HTTP endpoint, e.g. "http://127.0.0.1:9222". */
  cdpEndpoint: string;
  navigationTimeoutMs?: number;
}

/** A live element's observable signature, used for staleness checks. */
export interface TargetDescription {
  role: string;
  name: string;
  tag: string;
  visible: boolean;
  /** Current value for input/textarea/select (when readable). */
  value?: string;
  /** Checked state for checkbox/radio/switch (when applicable). */
  checked?: boolean;
  /** The input's type attribute (e.g. "password") — used by the policy engine. */
  inputType?: string;
}

/**
 * Semantic signature binding a ref to what it meant at snapshot time.
 * Used by the grounding layer to detect stale refs and re-ground safely.
 */
export interface ElementDescriptor {
  ref: string;
  snapshotId: string;
  frameId?: string;
  role: string;
  name: string;
  tag: string;
  selector: string;
  text?: string;
}

/** One browser tab/page known to the backend. */
export interface TabInfo {
  /** Bridge-assigned stable id for the session lifetime, e.g. "tab-1". */
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/** One iframe in the active page. */
export interface FrameInfo {
  /** Bridge-assigned id for the session lifetime, e.g. "frame-1". */
  id: string;
  url: string;
  name: string;
}

/** URL/title/meta description of the active page. */
export interface PageInfo {
  url: string;
  title: string;
  description: string;
}

/** A completed download tracked by the backend. */
export interface DownloadRecord {
  url: string;
  suggestedFilename: string;
  /** Safe absolute path where the file was saved (inside the bridge download dir). */
  path: string;
  finishedAt: string;
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
