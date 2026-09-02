/**
 * Known OpenAI-compatible inference endpoints.
 *
 * Adding a gateway meant typing a name, a base URL and a model id by hand for
 * every provider — and a base URL is exactly the kind of value that is tedious
 * to remember, easy to get subtly wrong (a missing `/v1` returns 404s that look
 * like auth failures), and identical for everyone using that provider. These
 * are starting points: picking one fills the form, and every field stays
 * editable, so a custom endpoint or a second account with the same provider is
 * still just as reachable.
 *
 * `model` is a sensible default the provider actually serves, not a
 * recommendation — the field is there to be changed.
 */
export interface GatewayPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  /** Shown under the form when chosen, for anything non-obvious about the endpoint. */
  note?: string;
}

export const GATEWAY_PRESETS: readonly GatewayPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
  },
  {
    id: 'together',
    label: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
  },
  {
    id: 'xai',
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-2-latest',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    model: 'sonar',
    note: 'Perplexity serves the OpenAI routes at the domain root, with no /v1 suffix.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    note: 'Runs on this machine. It needs no API key, and a workspace opened on another device cannot reach it.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    note: 'Runs on this machine. It needs no API key, and a workspace opened on another device cannot reach it.',
  },
];

export function gatewayPresetById(id: string): GatewayPreset | undefined {
  return GATEWAY_PRESETS.find(preset => preset.id === id);
}
