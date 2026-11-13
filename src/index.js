/**
 * r6t5 Copilot — Cloudflare Worker
 *
 * 同时承担两件事：
 *   1. 静态站点：把 ./public 下的单页应用（index.html）发给浏览器；
 *   2. AI 代理：/api/chat、/api/image、/api/vision、/api/url 四类接口，
 *      全部走 Workers AI binding（env.AI），不需要在浏览器里暴露任何 API Key。
 *
 * 部署：npx wrangler deploy
 */

const CHAT_MODELS = new Set([
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/openai/gpt-oss-120b',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
]);

const VISION_MODELS = new Set([
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/moondream/moondream3.1-9B-A2B',
  '@cf/llava-hf/llava-1.5-7b-hf',
]);

const IMAGE_MODELS = new Set([
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/black-forest-labs/flux-2-dev',
  '@cf/black-forest-labs/flux-2-klein-9b',
  '@cf/bytedance/stable-diffusion-xl-lightning',
  '@cf/leonardo/phoenix-1.0',
]);

const DEFAULT_CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const DEFAULT_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 60000;
const MAX_TOTAL_CHARS = 220000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    // 静态站点：优先交给 assets binding；未配置时退化为入口页
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('r6t5 Copilot worker is running. Configure [assets] in wrangler.toml.', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};

async function handleApi(request, env, url) {
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json(
      {
        ok: true,
        service: 'r6t5-copilot',
        chat_models: [...CHAT_MODELS],
        vision_models: [...VISION_MODELS],
        image_models: [...IMAGE_MODELS],
      },
      cors,
    );
  }

  if (request.method !== 'POST') {
    return json({ error: '仅支持 POST' }, cors, 405);
  }

  const authError = checkAccessKey(request, env);
  if (authError) return json({ error: authError }, cors, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体必须是合法 JSON' }, cors, 400);
  }

  try {
    switch (url.pathname) {
      case '/api/chat':
        return await handleChat(body, env, cors);
      case '/api/vision':
        return await handleVision(body, env, cors);
      case '/api/image':
        return await handleImage(body, env, cors);
      case '/api/url':
        return await handleUrl(body, env, cors);
      case '/api/agree-vision':
        return await handleAgreeVision(body, env, cors);
      default:
        return json({ error: '接口不存在' }, cors, 404);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return json({ error: `上游调用失败：${message}` }, cors, 502);
  }
}

/* ------------------------------- 接口实现 ------------------------------- */

async function handleChat(body, env, cors) {
  const model = body.model || DEFAULT_CHAT_MODEL;
  if (!CHAT_MODELS.has(model)) {
    return json({ error: `不支持的对话模型：${model}` }, cors, 400);
  }

  const messages = normalizeMessages(body.messages);
  if (!messages) return json({ error: 'messages 缺失或为空' }, cors, 400);
  if (!messages.every((m) => typeof m.content === 'string')) {
    return json({ error: '对话消息只接受纯文本；图片请走 /api/vision' }, cors, 400);
  }

  return streamFromAI(env, model, {
    messages,
    stream: true,
    max_tokens: clampInt(body.max_tokens, 256, 2560, 1280),
    temperature: clampNum(body.temperature, 0, 2, 0.6),
  }, cors);
}

async function handleVision(body, env, cors) {
  const model = body.model || DEFAULT_VISION_MODEL;
  if (!VISION_MODELS.has(model)) {
    return json({ error: `不支持的视觉模型：${model}` }, cors, 400);
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages 缺失或为空' }, cors, 400);
  }

  return streamFromAI(env, model, {
    messages,
    stream: true,
    max_tokens: clampInt(body.max_tokens, 128, 1600, 768),
  }, cors, '视觉模型首次使用需先同意 Meta License（调用 /api/agree-vision）');
}

async function handleImage(body, env, cors) {
  const model = body.model || DEFAULT_IMAGE_MODEL;
  if (!IMAGE_MODELS.has(model)) {
    return json({ error: `不支持的图像模型：${model}` }, cors, 400);
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json({ error: 'prompt 不能为空' }, cors, 400);
  if (prompt.length > 2048) return json({ error: 'prompt 过长（上限 2048 字符）' }, cors, 400);

  const input = { prompt };
  if (model === '@cf/black-forest-labs/flux-1-schnell') {
    input.steps = clampInt(body.steps, 1, 8, 4);
    input.seed = randomSeed();
  }

  const result = await env.AI.run(model, input);
  const base64 = extractImage(result);
  if (!base64) {
    return json({ error: '模型未返回图像数据，请换一个图像模型重试' }, cors, 502);
  }

  const contentType = base64.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
  return json({ dataURI: `data:${contentType};base64,${base64}`, model }, cors);
}

async function handleAgreeVision(body, env, cors) {
  const model = body.model || DEFAULT_VISION_MODEL;
  if (!VISION_MODELS.has(model)) {
    return json({ error: `不支持的视觉模型：${model}` }, cors, 400);
  }
  try {
    await env.AI.run(model, { prompt: 'agree' });
    return json({ ok: true, approved: model }, cors);
  } catch (err) {
    return json({ error: `同意协议失败：${err.message || err}` }, cors, 502);
  }
}

async function handleUrl(body, env, cors) {
  const raw = typeof body.url === 'string' ? body.url.trim() : '';
  if (!raw) return json({ error: 'url 不能为空' }, cors, 400);

  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'URL 格式不合法' }, cors, 400);
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    return json({ error: '只支持 http / https' }, cors, 400);
  }
  if (isPrivateHost(target.hostname)) {
    return json({ error: '不允许访问内网地址' }, cors, 400);
  }

  const res = await fetch(target.toString(), {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; r6t5-copilot)' },
    redirect: 'follow',
  });
  if (!res.ok) {
    return json({ error: `抓取失败：HTTP ${res.status}` }, cors, 502);
  }

  const type = res.headers.get('content-type') || '';
  if (!/text\/|html|json|xml/.test(type)) {
    return json({ error: `不支持的内容类型：${type || 'unknown'}` }, cors, 415);
  }

  const html = (await res.text()).slice(0, 1500000);
  const extracted = htmlToText(html);
  if (extracted.text.length < 40) {
    return json({ error: '页面正文为空或过短，可能需登录或为纯前端渲染' }, cors, 422);
  }

  return json(
    {
      url: target.toString(),
      title: extracted.title || target.hostname,
      text: extracted.text.slice(0, 40000),
      truncated: extracted.text.length > 40000,
    },
    cors,
  );
}

/* ------------------------------- AI 流式桥接 ------------------------------- */

function streamFromAI(env, model, input, cors, licenseHint = '') {
  const runPromise = env.AI.run(model, input);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      let reader;
      try {
        const upstream = await runPromise;
        if (!upstream || typeof upstream.getReader !== 'function') {
          // 部分模型/绑定在 stream:true 下仍返回完整对象
          const text = extractText(upstream);
          if (text) send({ delta: text });
          send({ done: true });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        reader = upstream.getReader();
      } catch (err) {
        send({ error: friendlyError(err, licenseHint) });
        controller.close();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }
            const delta = extractDelta(parsed);
            if (delta) send({ delta });
          }
        }
        send({ done: true });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        send({ error: friendlyError(err, licenseHint) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...cors,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

function extractDelta(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (typeof parsed.response === 'string') return parsed.response;
  const choices = parsed.choices;
  if (Array.isArray(choices) && choices[0]) {
    const c = choices[0];
    if (typeof c.text === 'string') return c.text;
    if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
    if (c.message && typeof c.message.content === 'string') return c.message.content;
  }
  return '';
}

function extractText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj.response === 'string') return obj.response;
  if (Array.isArray(obj.choices) && obj.choices[0]?.message?.content) return obj.choices[0].message.content;
  return '';
}

function extractImage(result) {
  if (!result) return '';
  let image = result.image;
  if (typeof image === 'string') return stripDataPrefix(image);
  if (image instanceof Uint8Array) return bytesToBase64(image);
  if (Array.isArray(image)) return bytesToBase64(new Uint8Array(image));
  if (typeof result === 'string') return stripDataPrefix(result);
  return '';
}

function friendlyError(err, licenseHint) {
  const raw = (err && err.message) || String(err);
  if (/license|agree|accept|4033|5016/i.test(raw) && licenseHint) {
    return `视觉模型尚未授权。请先调用 POST /api/agree-vision 同意 Meta License 后再试。原始信息：${raw}`;
  }
  if (/neurons|quota|limit|capacity|429|3040/i.test(raw)) {
    return `Workers AI 配额或并发受限，请稍后重试或更换模型。原始信息：${raw}`;
  }
  return `模型返回错误：${raw}`;
}

/* ------------------------------- 工具函数 ------------------------------- */

function corsHeaders(request, env) {
  const configured = (env.ALLOWED_ORIGIN || '*').trim();
  const origin = request.headers.get('origin') || '';
  const allow = configured === '*' || configured === '' ? '*' : configured.split(',').map((s) => s.trim()).includes(origin) ? origin : configured.split(',')[0].trim();

  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-copilot-key',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function checkAccessKey(request, env) {
  const expected = (env.ACCESS_KEY || '').trim();
  if (!expected) return null;
  const provided = request.headers.get('x-copilot-key') || '';
  return provided === expected ? null : '访问密钥不正确，请在设置中填写 x-copilot-key';
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
  });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const trimmed = messages.slice(-MAX_MESSAGES);
  let total = 0;
  for (const m of trimmed) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system')) return null;
    if (typeof m.content !== 'string' || m.content.length === 0) return null;
    if (m.content.length > MAX_MESSAGE_CHARS) return null;
    total += m.content.length;
    if (total > MAX_TOTAL_CHARS) return null;
  }
  return trimmed.map((m) => ({ role: m.role, content: m.content }));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function randomSeed() {
  return Math.floor(Math.random() * 1000000000) + 1;
}

function stripDataPrefix(s) {
  return s.replace(/^data:[^;]+;base64,/, '');
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (['localhost', '0.0.0.0', 'metadata.google.internal'].includes(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (host.startsWith('[') || host.includes(':')) {
    // IPv6：只放行公网地址的粗略判断
    if (host.startsWith('[') && (host.startsWith('[::1]') || host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe80'))) {
      return true;
    }
  }
  return false;
}

function htmlToText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';

  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|iframe|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');

  body = body
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');

  const text = decodeEntities(body)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();

  return { title, text };
}

function decodeEntities(input) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return input
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}
