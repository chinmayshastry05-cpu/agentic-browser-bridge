/**
 * tests/fixtures/mock-backend.ts — shared offline MockBackend (extracted verbatim from tests/mcp.test.ts).
 * No real browser, no network. Import this instead of duplicating the mock.
 */
import type {
  BrowserAttachOptions,
  BrowserBackend,
  DomNode,
  DownloadRecord,
  ElementDescriptor,
  FrameInfo,
  PageInfo,
  PageSnapshot,
  TabInfo,
  TargetDescription,
} from '../../src/types.js';

export function node(over: Partial<DomNode> & { ref: string }): DomNode {
  return {
    role: 'button',
    name: '',
    tag: 'button',
    text: '',
    attributes: {},
    selector: `#${over.ref}`,
    parentRef: null,
    childrenRefs: [],
    visible: true,
    ...over,
  };
}

export function sampleSnapshot(): PageSnapshot {
  const nodes: DomNode[] = [
    node({ ref: 'e1', role: 'heading', name: 'Welcome', tag: 'h1' }),
    node({ ref: 'e2', role: 'textbox', name: 'Your name', tag: 'input', attributes: { type: 'text', placeholder: 'e.g. Ada' } }),
    node({ ref: 'e3', role: 'button', name: 'Greet me', tag: 'button', parentRef: 'e4' }),
    node({ ref: 'e4', role: 'form', name: 'greet form', tag: 'form', childrenRefs: ['e3'] }),
    node({ ref: 'e5', role: 'link', name: 'Docs', tag: 'a', attributes: { href: 'https://example.com' }, visible: false }),
  ];
  return { snapshotId: 'snap-test', url: 'https://example.test/', title: 'Demo', capturedAt: '2026-10-07T00:00:00.000Z', nodes };
}

export class MockBackend implements BrowserBackend {
  readonly backendName = 'mock';
  navigated: string[] = [];
  clicked: string[] = [];
  typed: Array<{ selector: string; text: string; submit: boolean }> = [];
  screenshots: string[] = [];
  snapshotData: PageSnapshot = sampleSnapshot();
  started = false;
  attached: string[] = [];
  tabs: TabInfo[] = [
    { id: 'tab-1', url: 'https://example.test/', title: 'Demo', active: true },
  ];

  get connected(): boolean { return this.started; }
  get isUserBrowser(): boolean { return false; }

  async start(): Promise<void> { this.started = true; }
  async attach(opts: BrowserAttachOptions): Promise<void> { this.attached.push(opts.cdpEndpoint); this.started = true; }
  async stop(): Promise<void> { this.started = false; }
  async goto(url: string): Promise<void> { this.navigated.push(url); }
  async goBack(): Promise<void> { /* noop */ }
  async goForward(): Promise<void> { /* noop */ }
  async reload(): Promise<void> { /* noop */ }
  async listTabs(): Promise<TabInfo[]> { return this.tabs; }
  async activeTab(): Promise<TabInfo> { return this.tabs.find((t) => t.active) ?? this.tabs[0]!; }
  async openTab(url?: string): Promise<TabInfo> {
    const tab: TabInfo = { id: `tab-${this.tabs.length + 1}`, url: url ?? 'about:blank', title: '', active: true };
    for (const t of this.tabs) t.active = false;
    this.tabs.push(tab);
    return tab;
  }
  async switchTab(tabId: string): Promise<TabInfo> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`unknown tab "${tabId}"`);
    for (const t of this.tabs) t.active = t === tab;
    return tab;
  }
  async closeTab(tabId: string): Promise<void> {
    if (this.tabs.length <= 1) throw new Error('refusing to close the last tab of the session');
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    if (!this.tabs.some((t) => t.active)) this.tabs[0]!.active = true;
  }
  private snapshotCounter = 0;
  async snapshot(): Promise<PageSnapshot> {
    this.snapshotCounter += 1;
    return { ...this.snapshotData, snapshotId: `snap-mock-${this.snapshotCounter}` };
  }
  async click(selector: string, _frameId?: string): Promise<void> {
    if (this.nextClickError) {
      const e = this.nextClickError;
      this.nextClickError = null;
      throw new Error(e);
    }
    this.clicked.push(selector);
  }
  /** Set to make the next click() throw (recovery tests). */
  nextClickError: string | null = null;
  async dblclick(selector: string, _frameId?: string): Promise<void> { this.clicked.push(`dbl:${selector}`); }
  async type(selector: string, text: string, submit: boolean, _frameId?: string): Promise<void> {
    this.typed.push({ selector, text, submit });
    this.fieldValues[selector] = text;
  }
  async clear(selector: string, _frameId?: string): Promise<void> { this.typed.push({ selector, text: '', submit: false }); this.fieldValues[selector] = ''; }
  async pressKey(key: string, _frameId?: string): Promise<void> { this.typed.push({ selector: '<keyboard>', text: key, submit: false }); }
  async hover(selector: string, _frameId?: string): Promise<void> { this.clicked.push(`hover:${selector}`); }
  async focus(selector: string, _frameId?: string): Promise<void> { this.clicked.push(`focus:${selector}`); }
  async scrollIntoView(selector: string, _frameId?: string): Promise<void> { this.clicked.push(`scrollto:${selector}`); }
  async selectOption(selector: string, values: string[], _frameId?: string): Promise<string[]> {
    this.typed.push({ selector, text: values.join(','), submit: false });
    this.fieldValues[selector] = values[0] ?? '';
    return values;
  }
  async setChecked(selector: string, checked: boolean, _frameId?: string): Promise<void> {
    this.typed.push({ selector, text: checked ? 'checked' : 'unchecked', submit: false });
    this.fieldChecked[selector] = checked;
  }
  async scrollBy(_dx: number, _dy: number): Promise<void> { /* noop */ }
  async waitForSelector(_selector: string, _state: 'visible' | 'hidden' | 'attached', _timeoutMs: number, _frameId?: string): Promise<void> { /* noop */ }
  async pageText(selector?: string, _frameId?: string): Promise<string> {
    return selector ? `text of ${selector}` : 'page text';
  }
  async pageInfo(): Promise<PageInfo> {
    return { url: this.snapshotData.url, title: this.snapshotData.title, description: 'mock page' };
  }
  async listFrames(): Promise<FrameInfo[]> { return []; }
  async frameSnapshot(_frameId: string): Promise<PageSnapshot> { throw new Error('no frames in mock'); }
  /** Override per-test to simulate DOM drift; default mirrors the last snapshot. */
  describeOverride: Record<string, TargetDescription | null> | null = null;
  fieldValues: Record<string, string> = {};
  fieldChecked: Record<string, boolean> = {};
  async describeTarget(selector: string, _frameId?: string): Promise<TargetDescription | null> {
    if (this.describeOverride && selector in this.describeOverride) {
      return this.describeOverride[selector];
    }
    const n = this.snapshotData.nodes.find((x) => x.selector === selector);
    if (!n) return null;
    return {
      role: n.role,
      name: n.name,
      tag: n.tag,
      visible: n.visible,
      value: this.fieldValues[selector] ?? n.text,
      checked: this.fieldChecked[selector],
    };
  }
  async uploadFile(selector: string, filePath: string, _frameId?: string): Promise<void> {
    this.typed.push({ selector, text: `upload:${filePath}`, submit: false });
  }
  async recentDownloads(_consume: boolean): Promise<DownloadRecord[]> { return []; }
  async waitForDownload(_timeoutMs: number): Promise<DownloadRecord> { throw new Error('no downloads in mock'); }
  async screenshot(path: string): Promise<void> { this.screenshots.push(path); }
  currentUrl(): string { return this.snapshotData.url; }
  async title(): Promise<string> { return this.snapshotData.title; }
}

