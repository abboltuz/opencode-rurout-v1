import type { AuthHook, Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import {
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./constants.js";
import { fetchGatewayModels } from "./discovery.js";
import {
  canonicalId,
  displayName,
  familyOf,
  isImage,
  isReasoning,
  lookup,
} from "./fallback.js";

interface RuroutOptions {
  baseURL?: string;
}

type AnyRecord = Record<string, any>;

function baseURLFrom(opts: RuroutOptions): string {
  const raw = opts.baseURL ?? process.env.RUROUT_BASE_URL ?? DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

function resolveApiKey(provider: AnyRecord | undefined): string {
  const options = (provider?.options ?? {}) as Record<string, unknown>;
  const rawKey = options.apiKey;
  if (typeof rawKey === "string" && rawKey.length > 0) return rawKey;
  return process.env.RUROUT_API_KEY ?? "";
}

async function log(
  input: PluginInput,
  level: "info" | "warn" | "error",
  message: string,
): Promise<void> {
  try {
    await input.client.app.log({ body: { service: "rurout", level, message } });
  } catch {
    // Logging is best-effort.
  }
}

function toV1Model(canonical: string, apiId: string, display: string | undefined): AnyRecord {
  const fallback = lookup(canonical);
  const image = isImage(canonical);
  const text = !canonical.startsWith("gpt-image-");
  const label = displayName(apiId, display);
  return {
    name: label.startsWith("RuRout") ? label : `RuRout ${label}`,
    family: familyOf(canonical),
    reasoning: isReasoning(apiId),
    tool_call: !image && text,
    attachment: image,
    cost: {
      input: fallback.input > 0 ? fallback.input : 1,
      output: fallback.outputCost > 0 ? fallback.outputCost : 5,
      cache_read: fallback.cacheRead ?? 0,
    },
    limit: { context: fallback.context, output: fallback.output },
  };
}

function pickApiId(ids: string[]): string {
  const rank = (id: string): number => {
    if (/-tiered$/i.test(id)) return 0;
    if (/-medium$/i.test(id)) return 1;
    if (/-high$/i.test(id)) return 2;
    if (/-low$/i.test(id)) return 3;
    if (/-thinking$/i.test(id)) return 4;
    if (/-preview$/i.test(id)) return 5;
    if (/-\d{8}$/.test(id)) return 6;
    return 7;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))[0]!;
}

async function fetchKeyLabel(baseURL: string, apiKey: string): Promise<string> {
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/sub2api/billing`, {
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return "";
    const body = (await response.json()) as { key_name?: unknown; group_name?: unknown };
    const keyName = typeof body.key_name === "string" ? body.key_name.trim() : "";
    const groupName = typeof body.group_name === "string" ? body.group_name.trim() : "";
    return sanitizeLabel(keyName || groupName);
  } catch {
    return "";
  }
}

function sanitizeLabel(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

async function ruroutPlugin(input: PluginInput, rawOpts?: RuroutOptions): Promise<Hooks> {
  const baseURL = baseURLFrom(rawOpts ?? {});
  return {
    async config(config: Config) {
      const root = config as AnyRecord;
      root.provider = root.provider ?? {};
      const existing = (root.provider[PROVIDER_ID] ?? {}) as AnyRecord;
      const options = { ...((existing.options ?? {}) as Record<string, unknown>) };
      if (typeof options.baseURL !== "string" || options.baseURL.length === 0) {
        options.baseURL = baseURL;
      }
      const provider: AnyRecord = {
        ...existing,
        npm: "@ai-sdk/openai-compatible",
        name: existing.name ?? PROVIDER_NAME,
        options,
        models: {},
      };
      root.provider[PROVIDER_ID] = provider;

      const apiKey = resolveApiKey(provider);
      if (!apiKey) {
        await log(input, "warn", "[rurout] no API key yet — run /connect rurout, then restart");
        return;
      }

      let live;
      try {
        live = await fetchGatewayModels(baseURL, apiKey);
      } catch (err) {
        await log(
          input,
          "warn",
          `[rurout] model discovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      const groups = new Map<string, { ids: string[]; display?: string }>();
      for (const m of live) {
        const canonical = canonicalId(m.id);
        const entry = groups.get(canonical) ?? { ids: [] };
        entry.ids.push(m.id);
        if (!entry.display && m.display_name && m.display_name !== m.id) {
          entry.display = m.display_name;
        }
        groups.set(canonical, entry);
      }
      const keyLabel = await fetchKeyLabel(baseURL, apiKey);
      const providerName = keyLabel ? `RuRout ${keyLabel}` : PROVIDER_NAME;
      provider.name = providerName;
      const models: Record<string, AnyRecord> = {};
      for (const [canonical, entry] of groups) {
        const apiId = pickApiId(entry.ids);
        const model = toV1Model(canonical, apiId, entry.display);
        if (keyLabel) {
          model.name = `${providerName} ${displayName(apiId, entry.display)}`;
        }
        models[canonical] = model;
      }
      provider.models = models;
      await log(input, "info", `[rurout] discovered ${Object.keys(models).length} models`);
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "API Key",
          prompts: [
            {
              type: "text",
              key: "api_key",
              message: "Enter your rurout API key:",
              placeholder: "sk-...",
            },
          ],
          async authorize(inputs) {
            const key = inputs?.api_key;
            if (!key) return { type: "failed" };
            return { type: "success", key };
          },
        },
      ],
      loader: async (getAuth) => {
        try {
          const auth = await getAuth();
          if (!auth) return {};
          if (auth.type === "api" && auth.key) return { apiKey: auth.key };
          return {};
        } catch {
          return {};
        }
      },
    } satisfies AuthHook,
  };
}

export default ruroutPlugin;
