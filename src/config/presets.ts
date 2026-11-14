import type { WireApi } from "./schema.js";

export interface ProviderPreset {
  id: string;
  label: string;
  description: string;
  base_url: string;
  wire_api: WireApi;
  api_key_env?: string;
  needs_key: boolean;
  headers?: Record<string, string>;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "opencode-go",
    label: "OpenCode Go",
    description: "OpenCode Go subscription endpoint",
    base_url: "https://opencode.ai/inference/go/openai/v1",
    wire_api: "responses",
    api_key_env: "OPENCODE_API_KEY",
    needs_key: true,
    headers: { "x-opencode-session": "{session_id}" },
  },
  {
    id: "opencode",
    label: "OpenCode Console",
    description: "OpenCode pay-as-you-go endpoint",
    base_url: "https://opencode.ai/inference/openai/v1",
    wire_api: "responses",
    api_key_env: "OPENCODE_API_KEY",
    needs_key: true,
    headers: { "x-opencode-session": "{session_id}" },
  },
  {
    id: "logfare",
    label: "Logfare",
    description: "Logfare OpenAI-compatible endpoint",
    base_url: "https://logfare.ai/v1",
    wire_api: "chat",
    api_key_env: "LOGFARE_API_KEY",
    needs_key: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Many hosted models behind one key",
    base_url: "https://openrouter.ai/api/v1",
    wire_api: "responses",
    api_key_env: "OPENROUTER_API_KEY",
    needs_key: true,
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    description: "Hosted open models",
    base_url: "https://api.fireworks.ai/inference/v1",
    wire_api: "responses",
    api_key_env: "FIREWORKS_API_KEY",
    needs_key: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek platform API",
    base_url: "https://api.deepseek.com/v1",
    wire_api: "chat",
    api_key_env: "DEEPSEEK_API_KEY",
    needs_key: true,
  },
  {
    id: "groq",
    label: "Groq",
    description: "Low-latency hosted open models",
    base_url: "https://api.groq.com/openai/v1",
    wire_api: "chat",
    api_key_env: "GROQ_API_KEY",
    needs_key: true,
  },
  {
    id: "ollama",
    label: "Ollama",
    description: "Models served on this machine by Ollama",
    base_url: "http://localhost:11434/v1",
    wire_api: "chat",
    needs_key: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    description: "Models served on this machine by LM Studio",
    base_url: "http://localhost:1234/v1",
    wire_api: "chat",
    needs_key: false,
  },
];

export const CUSTOM_PRESET_ID = "custom";

export function findPreset(id: string): ProviderPreset | undefined {
  const wanted = id.toLowerCase();
  return PROVIDER_PRESETS.find((preset) => preset.id === wanted);
}
