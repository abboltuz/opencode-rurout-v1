import type { AuthHook, Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import {
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./constants.js";
import { fetchGatewayModels } from "./discovery.js";
import { keyFingerprint, purgeLegacyFileCache } from "./cache.js";
import {
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

function providerApiKey(provider: AnyRecord | undefined): string {
  const options = (provider?.options ?? {}) as Record<string, unknown>;
  for (const field of ["apiKey", "api_key", "key", "token"] as const) {
    const raw = options[field];
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return process.env.RUROUT_API_KEY ?? "";
}

function resolveApiKey(provider: AnyRecord | undefined): string {
  return providerApiKey(provider);
}

async function buildModelsForKey(
  input: PluginInput,
  baseURL: string,
  apiKey: string,
): Promise<{ models: Record<string, AnyRecord>; keyLabel: string } | null> {
  let live;
  try {
    live = await fetchGatewayModels(baseURL, apiKey);
  } catch (err) {
    await log(
      input,
      "warn",
      `[rurout] model discovery failed for key ${keyFingerprint(apiKey)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const keyLabel = await fetchKeyLabel(baseURL, apiKey);
  const models: Record<string, AnyRecord> = {};
  for (const entry of live) {
    // Preserve the exact ID returned for this key. Alias collapsing can select
    // an ID unavailable to the active key.
    const model = toV1Model(entry.id, entry.id, entry.display_name) as AnyRecord;
    const modelName = typeof model.name === "string" ? model.name : entry.id;
    if (keyLabel) {
      model.name = `RuRout ${keyLabel} ${displayName(entry.id, entry.display_name)}`;
    } else {
      model.name = modelName;
    }
    models[entry.id] = model;
  }
  return { models, keyLabel };
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
  const refreshTimer = setInterval(() => {
    void (async () => {
      try {
        // Reapply the running configuration so the config hook resolves the
        // current auth key and replaces the model inventory without a restart.
        const response = await (input.client.config.get as any)({
          query: { directory: input.directory },
        });
        const config = (response as AnyRecord)?.data ?? response;
        if (!config || typeof config !== "object") return;
        await (input.client.config.update as any)({
          query: { directory: input.directory },
          body: config,
        });
      } catch {
        // The next hourly tick retries; keep the last successful inventory.
      }
    })();
  }, 60 * 60 * 1000);
  if (typeof (refreshTimer as unknown as { unref?: () => void }).unref === "function") {
    (refreshTimer as unknown as { unref: () => void }).unref();
  }
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

      await purgeLegacyFileCache((message) => void log(input, "info", message));

       const apiKey = resolveApiKey(provider);
       if (!apiKey) {
         await log(input, "warn", "[rurout] no API key yet — run /connect rurout, then restart");
         return;
       }
       const built = await buildModelsForKey(input, baseURL, apiKey);
       if (!built) return;
       provider.name = built.keyLabel ? `RuRout ${built.keyLabel}` : PROVIDER_NAME;
       provider.models = built.models;
       await log(input, "info", `[rurout] discovered ${Object.keys(built.models).length} models for active key ${keyFingerprint(apiKey)}`);
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
    dispose: async () => {
      clearInterval(refreshTimer);
    },
  };
}

export default ruroutPlugin;
