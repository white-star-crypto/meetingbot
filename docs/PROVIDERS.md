# Provider status

Last checked: 2026-11-07 20:03 +08:00

## Doubao / Volcano Ark (enabled)

- Base URL: `https://ark.cn-beijing.volces.com/api/v3`
- OpenAI-compatible chat endpoint: `/chat/completions`
- Key source: `config/火山引擎.key` (Ark `ark-...` key)
- Activated in the Ark console: `Doubao-Seed-Evolving`, `Doubao-Seed-2.1-turbo`
- `Doubao-Seed-2.1-pro-260915`: **OK** now; `doubao-pro` is enabled and preset `three` uses it.
- High-thinking Doubao Pro can take ~4 minutes for the final foreman decision. The local config now uses `timeoutMs: 300000`; use `repair <run> --timeout-ms 600000` if a foreman decision still times out.
- `providers test` for `doubao` (Turbo) returns **OK** in about 4.7s.
- `doubao-seed-2-1-lite-260428` returned `InvalidEndpointOrModel.NotFound`; leave it out until the exact activated model ID is confirmed.
- Status: **enabled** for Turbo and Evolving; it still uses the same Ark key.

Official docs: [Volcengine Ark OpenAI-compatible SDK](https://console.volcengine.com/ark/region:cn-beijing/docs/compatible-with-openai-sdk)

## Wenxin / Baidu Qianfan (enabled)

- Base URL: `https://qianfan.baidubce.com/v2`
- OpenAI-compatible chat endpoint: `/chat/completions`
- Model: `ernie-5.1`
- Key source: `config/文言一心.key` (the file also contains `OPENAI_BASE_URL` and `MODEL_ID`)
- Result: **OK** after `max_tokens >= 256`.
- Important: `ernie-5.1` emits `reasoning_content`. With a tiny `max_tokens`, `content` can be empty because the budget is consumed by reasoning.
- `noThink: true` sends `enable_thinking: false`; this produced `content: "OK"` and no reasoning.
- Status: **enabled**, tags `chinese, reasoning`.

Official docs: [Baidu Qianfan OpenAI-compatible quick start](https://intl.cloud.baidu.com/zh/doc/qianfan/s/qm8qxemze-intl)

## Notes

- `providers test` consumes a small number of tokens.
- A provider being in the roster does not mean it is activated; the `enabled` flag and the real test are authoritative.
- The `ark.key` name in older scripts is legacy; the actual file on this machine is `config/火山引擎.key`.
- The Doubao entry is intentionally disabled rather than pretending it is usable.
