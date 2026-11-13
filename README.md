# r6t5 Copilot

一个跑在 Cloudflare 边缘上的单页 AI 工作台：**通用对话、代码助手、文档问答、文生图、读图问答**，五种能力共用一个 Worker 代理，前端是一个自包含的 `index.html`。

- 前端：`public/index.html`（单文件，无构建、无框架、无第三方依赖）
- 后端：`src/index.js`（Cloudflare Worker，通过 `env.AI` 调用 Workers AI）
- 部署：`wrangler deploy` 一条命令，页面与 API 同源，**API Key 不会出现在浏览器里**

## 能力

| 模式 | 做什么 | 默认模型 |
| --- | --- | --- |
| 对话 | 多轮聊天、流式输出、可切换模型 | `@cf/meta/llama-3.1-8b-instruct-fp8` |
| 代码 | 解释、排错、改写，围栏代码块带一键复制 | `@cf/qwen/qwen2.5-coder-32b-instruct` |
| 文档 | 抓取网页正文或粘贴长文，只依据材料回答 | `@cf/zai-org/glm-5.3-flash`（1M 上下文） |
| 图像 · 生成 | 文生图、再生成、下载 | `@cf/black-forest-labs/flux-1-schnell` |
| 图像 · 读图 | 上传图片提问，浏览器内先压缩再上传 | `@cf/meta/llama-3.2-11b-vision-instruct` |

模型清单以 Cloudflare 官方 [Workers AI Models](https://developers.cloudflare.com/workers-ai/models/) 为准；Worker 里做了白名单校验，只放行下面这些 ID。

<details>
<summary>允许调用的模型</summary>

对话 / 代码 / 文档：

- `@cf/meta/llama-3.1-8b-instruct-fp8`
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `@cf/qwen/qwen3-30b-a3b-fp8`
- `@cf/zai-org/glm-5.3-flash`
- `@cf/qwen/qwen2.5-coder-32b-instruct`
- `@cf/moonshotai/kimi-k2.7-code`
- `@cf/openai/gpt-oss-120b`
- `@cf/google/gemma-4-26b-a4b-it`
- `@cf/deepseek-ai/deepseek-v4-flash-0731`

视觉：`@cf/meta/llama-3.2-11b-vision-instruct`、`@cf/moondream/moondream3.1-9B-A2B`、`@cf/llava-hf/llava-1.5-7b-hf`

图像：`@cf/black-forest-labs/flux-1-schnell`、`@cf/black-forest-labs/flux-2-dev`、`@cf/black-forest-labs/flux-2-klein-9b`、`@cf/bytedance/stable-diffusion-xl-lightning`、`@cf/leonardo/phoenix-1.0`

</details>

## 部署

需要 Cloudflare 账号（Workers AI 有免费额度，超出按 Neurons 计费）。

```bash
npm install
npx wrangler login
npx wrangler deploy
```

部署完成后会得到 `https://r6t5-copilot.<你的子域>.workers.dev`，直接打开就是完整应用，**不需要再配置任何 API Key**。

### 首次读图需要同意许可

`@cf/meta/llama-3.2-11b-vision-instruct` 属于 Meta 许可模型，第一次使用要发一次 `prompt: "agree"`。两种方式任选：

1. 打开页面 → 设置 → 点「同意 Meta License」；
2. 命令行：

```bash
curl -X POST https://r6t5-copilot.<你的子域>.workers.dev/api/agree-vision \
  -H "content-type: application/json" -d '{}'
```

### 可选：加访问密钥

Worker 默认对公网开放，任何人拿到域名都能消耗你的额度。要收紧：

```bash
npx wrangler secret put ACCESS_KEY     # 输入一个足够长的随机串
```

然后在页面「设置 → 访问密钥」里填同一个值，请求会带 `x-copilot-key`。

### 可选：限制跨域来源

前端和 Worker 同源部署时不用管。若把 `index.html` 放到别的域名，请在 `wrangler.toml` 里改：

```toml
[vars]
ALLOWED_ORIGIN = "https://your.domain"
```

并在页面的「设置 → Worker 端点」里填 Worker 的完整地址。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务状态与可用模型清单 |
| POST | `/api/chat` | `{ messages, model, temperature?, max_tokens? }`，SSE 流式返回 `{delta}` |
| POST | `/api/vision` | `{ messages, model }`，messages 的 content 用 `[{type:"text"},{type:"image_url"}]` |
| POST | `/api/image` | `{ prompt, model, steps? }`，返回 `{ dataURI }` |
| POST | `/api/url` | `{ url }`，抓取网页并抽取正文 `{ title, text, truncated }` |
| POST | `/api/agree-vision` | 同意 Meta License |

流式响应统一为：

```
data: {"delta":"你"}
data: {"delta":"好"}
data: [DONE]
```

出错时返回一帧 `data: {"error":"..."}`，前端按消息级错误展示，不会静默失败。

## 安全与边界

- **密钥不下发**：Workers AI 走 binding，浏览器只和自家 Worker 通信；`ACCESS_KEY` 也只做请求头校验。
- **模型白名单**：请求里的 `model` 必须命中白名单，避免被当成任意模型网关。
- **输入上限**：最多 24 条消息、单条 60k 字符、总计 220k 字符；`prompt` 上限 2048 字符。
- **抓取防 SSRF**：`/api/url` 只允许 http/https，拒绝 localhost、`*.local`、`*.internal` 与私有网段，正文截断到 1.5MB 原文 / 40k 字符输出。
- **成本**：图像生成与 70B 级模型消耗 Neurons 较快，公网部署请自己加访问密钥或 Cloudflare Access。

## 本地开发

```bash
npm run dev      # wrangler dev，localhost:8787，AI binding 本地也可用
npm run check    # 语法检查
```

本地 `wrangler dev` 同样需要先 `wrangler login`（AI binding 会走你的账号配额）。

## 目录

```
.
├── public/
│   └── index.html    # 单页应用（内联 CSS/JS，无外部 JS 依赖）
├── src/
│   └── index.js      # Worker：静态资源 + AI 代理 + 抓取
├── wrangler.toml
└── package.json
```

## 许可

代码以 MIT 发布；模型使用需遵守各家模型自身的许可（Meta Llama、Black Forest Labs FLUX 等）。
