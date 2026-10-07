/**
 * openai.ts — pluggable LLM provider adapter.
 *
 * Security contract (hard requirement of this project):
 *   - The API key is NEVER hardcoded, logged, or stored in config files.
 *   - It is read at runtime from the OPENAI_API_KEY environment variable
 *     (or a custom env var you pass explicitly).
 *   - The adapter speaks the OpenAI Chat Completions HTTP API, so it also
 *     works with any OpenAI-compatible endpoint via `baseUrl`.
 *
 * No network call is made unless you construct the adapter AND call complete().
 * Unit tests stub `fetch`, so the suite runs fully offline.
 */
import type { ChatMessage, LLMProvider } from './types.js';

export interface OpenAIAdapterOptions {
  /** Environment variable holding the key. Default: "OPENAI_API_KEY". */
  apiKeyEnv?: string;
  /** Override for OpenAI-compatible gateways. Default: "https://api.openai.com/v1". */
  baseUrl?: string;
  /** Model name. Default: "gpt-4o-mini". */
  model?: string;
  temperature?: number;
  /** Fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIAdapter implements LLMProvider {
  readonly name = 'openai-compatible';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIAdapterOptions = {}) {
    const envVar = opts.apiKeyEnv ?? 'OPENAI_API_KEY';
    const key = process.env[envVar];
    if (!key) {
      throw new Error(
        `LLM API key missing: set the ${envVar} environment variable. ` +
          `The key is never hardcoded or committed — see README.md.`,
      );
    }
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? 'gpt-4o-mini';
    this.temperature = opts.temperature ?? 0.2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Build the request payload without sending — useful for tests/inspection. */
  buildRequest(messages: ChatMessage[]): { url: string; body: Record<string, unknown> } {
    return {
      url: `${this.baseUrl}/chat/completions`,
      body: {
        model: this.model,
        temperature: this.temperature,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        response_format: { type: 'json_object' },
      },
    };
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const { url, body } = this.buildRequest(messages);
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Key travels only in the Authorization header of this single request.
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (json.error?.message) throw new Error(`LLM error: ${json.error.message}`);
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned an empty completion');
    return content;
  }
}

/**
 * Create a provider from environment. Currently only the OpenAI-compatible
 * adapter ships; returning a provider here keeps agent-loop.ts decoupled from
 * any concrete vendor.
 */
export function createProviderFromEnv(opts: OpenAIAdapterOptions = {}): LLMProvider {
  return new OpenAIAdapter(opts);
}
