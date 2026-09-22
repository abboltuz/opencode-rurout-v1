# @rurout/opencode-v1

OpenCode **1.x** provider plugin for [RuRout](https://rurout.online) — your gateway key becomes a first-class provider in `/models`.

> For OpenCode **2.x**, use [@rurout/opencode-v2](https://www.npmjs.com/package/@rurout/opencode-v2) instead.

## What the client gets

- New `RuRout` provider in the OpenCode model picker, next to the built-ins.
- Model list discovered live from `GET /v1/models` with the active key — each client sees exactly the models that key allows.
- Provider and model names include the admin-given key name from `GET /v1/sub2api/billing` (e.g. `RuRout Germes`).
- `/connect rurout` stores the key in OpenCode's auth system.
- The active key is checked on startup and hourly without a restart. A successful refresh replaces the list, including removing models unavailable to the key. Stale `~/.cache/opencode-rurout/models-*.json` files are deleted on startup.

## Install (OpenCode 1.x only)

```
opencode plugin add @rurout/opencode-v1@latest
```

Then inside OpenCode:

```
/connect
```

Select `rurout`, paste the gateway API key. Restart OpenCode, then `/models` → pick a `rurout/*` model.

Environment alternative (servers / CI):

```sh
export RUROUT_API_KEY=sk-...
opencode
```

## Custom gateway address

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@rurout/opencode-v1@latest"],
  "provider": {
    "rurout": {
      "options": {
        "baseURL": "https://your-gateway.example.com:9443/v1"
      }
    }
  }
}
```

Or `export RUROUT_BASE_URL=...`.

## How it works

The v1 `config` hook registers the `rurout` provider with `@ai-sdk/openai-compatible`, fetches `GET /v1/models` with the active key, preserves the exact IDs returned by the gateway, and fills in context/pricing metadata. The `auth` hook adds `/connect rurout`.
