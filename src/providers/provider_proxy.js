"use strict";

const crypto = require("crypto");

const SYSTEM_KEY_MARKER = "system-managed";
const ENCRYPTED_PREFIX = "enc:v1:";
const LEGACY_OBFUSCATED_PREFIX = "fzn::";
const DEFAULT_CHAT_MODELS = {
  openrouter: "openai/gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
  custom: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-20250514",
  deepseek: "deepseek-chat",
  nvidia: "meta/llama-3.1-70b-instruct",
  nvidia_deepseek: "deepseek-ai/deepseek-v4-pro",
  superior_llm: "meta/llama-3.1-70b-instruct"
};
const DEFAULT_CHAT_ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent",
  openai: "https://api.openai.com/v1/chat/completions",
  custom: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  deepseek: "https://api.deepseek.com/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
  nvidia_deepseek: "https://integrate.api.nvidia.com/v1/chat/completions",
  superior_llm: "https://integrate.api.nvidia.com/v1/chat/completions"
};
const DEFAULT_OCR_MODELS = {
  ocrspace: "",
  nvidia: "nemoretriever-ocr-v1",
  superior_ocr: "nemoretriever-ocr-v1"
};
const DEFAULT_OCR_ENDPOINTS = {
  ocrspace: "https://api.ocr.space/parse/image",
  nvidia: "https://integrate.api.nvidia.com/v1/ocr",
  superior_ocr: "https://integrate.api.nvidia.com/v1/ocr"
};
const DEFAULT_ASR_MODELS = {
  nvidia: "nvidia/parakeet-ctc-1.1b-asr",
  openai: "whisper-1"
};
const DEFAULT_ASR_ENDPOINTS = {
  nvidia: "https://integrate.api.nvidia.com/v1/audio/transcriptions",
  openai: "https://api.openai.com/v1/audio/transcriptions"
};
const DEFAULT_IMAGE_MODELS = {
  nvidia: "stable-diffusion-3.5-large",
  openai: "gpt-image-1"
};
const DEFAULT_IMAGE_ENDPOINTS = {
  nvidia: "https://integrate.api.nvidia.com/v1/images/generations",
  openai: "https://api.openai.com/v1/images/generations"
};
const DEFAULT_WEB_ENDPOINTS = {
  tavily: "https://api.tavily.com/search",
  serper: "https://google.serper.dev/search"
};
const SERVICE_PROVIDERS = {
  chat: ["superior_llm", "openrouter", "gemini", "openai", "anthropic", "deepseek", "nvidia", "nvidia_deepseek"],
  ocr: ["superior_ocr", "ocrspace", "nvidia"],
  asr: ["nvidia", "openai"],
  image: ["nvidia", "openai"],
  webSearch: ["tavily", "serper"]
};
const ENV_ALIASES = {
  openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_API"],
  gemini: ["GEMINI_API_KEY", "GEMINI_API", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY", "OPENAI_API"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_API"],
  deepseek: ["DEEPSEEK_API_KEY", "DEEPSEEK_API"],
  nvidia: ["NVIDIA_API_KEY", "NVIDIA_API", "NVIDEA_API_KEY", "NVIDEA_API"],
  nvidia_deepseek: ["NVIDIA_DEEPSEEK_API_KEY", "NVIDIA_DEEPSEEK_API", "NVIDIA_DEEPSEEK_KEY"],
  superior_llm: ["SUPERIOR_LLM_API_KEY", "SUPERIOR_LLM_API", "SUPERIOR_LLM_KEY"],
  superior_ocr: ["SUPERIOR_OCR_API_KEY", "SUPERIOR_OCR_API", "SUPERIOR_OCR_KEY"],
  ocrspace: ["OCRSPACE_API_KEY", "OCRSPACE_API", "OCR_SPACE_API_KEY", "OCR_SPACE_API"],
  tavily: ["TAVILY_API_KEY", "TAVILY_API"],
  serper: ["SERPER_API_KEY", "SERPER_API", "GOOGLE_SERPER_API_KEY"]
};

function normalizeProvider(value) {
  const safe = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (safe === "nvidea") {
    return "nvidia";
  }
  if (safe === "nvidia-deepseek" || safe === "nvidia_deepseek" || safe === "nvidea_deepseek") {
    return "nvidia_deepseek";
  }
  if (safe === "superior" || safe === "superior-llm" || safe === "superior_llm" || safe === "superior_llm_api") {
    return "superior_llm";
  }
  if (safe === "superior-ocr" || safe === "superior_ocr" || safe === "superior_ocr_api") {
    return "superior_ocr";
  }
  if (safe === "ocr_space" || safe === "ocr-space") {
    return "ocrspace";
  }
  return safe;
}

function getSystemProvider(service, provider) {
  const safeService = normalizeService(service);
  const safeProvider = normalizeProvider(provider);
  if (safeService === "chat" && safeProvider === "superior_llm") {
    return normalizeProvider(readEnvAny([
      "SUPERIOR_LLM_PROVIDER",
      "SUPERIOR_LLM_UPSTREAM_PROVIDER",
      "SUPERIOR_LLM_TYPE"
    ]) || "nvidia");
  }
  if (safeService === "ocr" && safeProvider === "superior_ocr") {
    return normalizeProvider(readEnvAny([
      "SUPERIOR_OCR_PROVIDER",
      "SUPERIOR_OCR_UPSTREAM_PROVIDER",
      "SUPERIOR_OCR_TYPE"
    ]) || "nvidia");
  }
  return safeProvider;
}

function normalizeService(value) {
  const safe = String(value || "").trim().toLowerCase();
  if (safe === "web" || safe === "web-search" || safe === "web_search") {
    return "webSearch";
  }
  if (safe === "websearch") {
    return "webSearch";
  }
  if (["chat", "ocr", "asr", "image"].includes(safe)) {
    return safe;
  }
  return "";
}

function readEnvAny(names) {
  for (const name of names || []) {
    const raw = String(name || "").trim();
    if (!raw) {
      continue;
    }
    const candidates = [raw, raw.toUpperCase(), raw.toLowerCase()];
    for (const candidate of candidates) {
      const value = String(process.env[candidate] || "").trim();
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function buildEnvNames(service, provider, suffix = "") {
  const safeService = normalizeService(service).toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const safeProvider = normalizeProvider(provider).toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const suffixPart = suffix ? `_${suffix}` : "";
  const names = [
    `${safeProvider}${suffixPart}`,
    `${safeService}_${safeProvider}${suffixPart}`,
    `FAIZANAI_${safeProvider}${suffixPart}`,
    `FAIZANAI_${safeService}_${safeProvider}${suffixPart}`,
    `THINKPULSE_${safeProvider}${suffixPart}`,
    `THINKPULSE_${safeService}_${safeProvider}${suffixPart}`
  ];
  if (safeProvider === "NVIDIA") {
    names.push(`NVIDEA${suffixPart}`, `${safeService}_NVIDEA${suffixPart}`);
  }
  if (safeProvider === "OCRSPACE") {
    names.push(`OCR_SPACE${suffixPart}`, `${safeService}_OCR_SPACE${suffixPart}`);
  }
  return names;
}

function getSystemApiKey(service, provider) {
  const safeProvider = normalizeProvider(provider);
  const names = [
    ...buildEnvNames(service, safeProvider, "API_KEY"),
    ...buildEnvNames(service, safeProvider, "API"),
    ...(ENV_ALIASES[safeProvider] || [])
  ];
  return readEnvAny(names);
}

function getSystemModel(service, provider) {
  const safeService = normalizeService(service);
  const safeProvider = normalizeProvider(provider);
  const defaults = safeService === "chat"
    ? DEFAULT_CHAT_MODELS
    : safeService === "ocr"
      ? DEFAULT_OCR_MODELS
      : safeService === "asr"
        ? DEFAULT_ASR_MODELS
        : safeService === "image"
          ? DEFAULT_IMAGE_MODELS
          : {};
  return readEnvAny(buildEnvNames(safeService, safeProvider, "MODEL")) || defaults[safeProvider] || "";
}

function getSystemEndpoint(service, provider) {
  const safeService = normalizeService(service);
  const safeProvider = normalizeProvider(provider);
  const defaults = safeService === "chat"
    ? DEFAULT_CHAT_ENDPOINTS
    : safeService === "ocr"
      ? DEFAULT_OCR_ENDPOINTS
      : safeService === "asr"
        ? DEFAULT_ASR_ENDPOINTS
        : safeService === "image"
          ? DEFAULT_IMAGE_ENDPOINTS
          : safeService === "webSearch"
            ? DEFAULT_WEB_ENDPOINTS
            : {};
  return readEnvAny(buildEnvNames(safeService, safeProvider, "ENDPOINT")) || defaults[safeProvider] || "";
}

function buildProxyEntry(service, provider, order = 0) {
  const safeService = normalizeService(service);
  const safeProvider = normalizeProvider(provider);
  if (!getSystemApiKey(safeService, safeProvider)) {
    return null;
  }
  return {
    id: `system-${safeService}-${safeProvider}`,
    provider: safeProvider,
    key: SYSTEM_KEY_MARKER,
    keySource: "system",
    viaBackend: true,
    backendProxy: true,
    model: getSystemModel(safeService, safeProvider),
    endpoint: getSystemEndpoint(safeService, safeProvider),
    enabled: true,
    order
  };
}

function buildSystemApiCapabilities() {
  const chatApis = SERVICE_PROVIDERS.chat.map((provider, index) => buildProxyEntry("chat", provider, index)).filter(Boolean);
  const ocrApis = SERVICE_PROVIDERS.ocr.map((provider, index) => buildProxyEntry("ocr", provider, index)).filter(Boolean);
  const asrApis = SERVICE_PROVIDERS.asr.map((provider, index) => buildProxyEntry("asr", provider, index)).filter(Boolean);
  const imageApis = SERVICE_PROVIDERS.image.map((provider, index) => buildProxyEntry("image", provider, index)).filter(Boolean);
  const webSearch = {
    tavily: getSystemApiKey("webSearch", "tavily") ? [SYSTEM_KEY_MARKER] : [],
    serper: getSystemApiKey("webSearch", "serper") ? [SYSTEM_KEY_MARKER] : [],
    backendProxy: true,
    keySource: "system"
  };
  return {
    multiApiMode: true,
    chatApis,
    ocrApis,
    asrApis,
    imageApis,
    webSearch
  };
}

function getEncryptionKey() {
  const secret = readEnvAny([
    "FAIZANAI_API_KEY_ENCRYPTION_SECRET",
    "THINKPULSE_API_KEY_ENCRYPTION_SECRET",
    "API_KEY_ENCRYPTION_SECRET",
    "KEY_ENCRYPTION_SECRET",
    "KMS_ENCRYPTION_SECRET"
  ]);
  if (!secret) {
    return null;
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function buildSecretContext(email, namespace = "") {
  const safeEmail = String(email || "").trim().toLowerCase().slice(0, 180);
  const safeNamespace = String(namespace || "").trim().toLowerCase().slice(0, 80);
  return `faizanai:user:${safeEmail}:${safeNamespace}`;
}

function isEncryptedSecret(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}

function decodeLegacyFrontendObfuscated(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith(LEGACY_OBFUSCATED_PREFIX)) {
    return raw;
  }
  try {
    return Buffer.from(raw.slice(LEGACY_OBFUSCATED_PREFIX.length), "base64").toString("utf8").trim();
  } catch (_error) {
    return "";
  }
}

function encryptSecret(value, context = "") {
  const raw = decodeLegacyFrontendObfuscated(value);
  if (!raw || isEncryptedSecret(raw)) {
    return raw;
  }
  const key = getEncryptionKey();
  if (!key) {
    throw new Error("API key encryption secret is not configured on the backend.");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const aad = Buffer.from(String(context || ""), "utf8");
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const payload = {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url")
  };
  return `${ENCRYPTED_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decryptSecret(value, context = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (!isEncryptedSecret(raw)) {
    return decodeLegacyFrontendObfuscated(raw);
  }
  const key = getEncryptionKey();
  if (!key) {
    throw new Error("API key encryption secret is not configured on the backend.");
  }
  const encoded = raw.slice(ENCRYPTED_PREFIX.length);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAAD(Buffer.from(String(context || ""), "utf8"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64url")),
    decipher.final()
  ]).toString("utf8").trim();
}

function protectApiEntry(entry, context) {
  if (!entry || typeof entry !== "object") {
    return entry;
  }
  const next = { ...entry };
  const key = String(next.key || next.apiKey || next.ocrApiKey || "").trim();
  if (key && key !== SYSTEM_KEY_MARKER) {
    next.key = encryptSecret(key, context);
  }
  delete next.apiKey;
  delete next.ocrApiKey;
  return next;
}

function protectUserStatePayload(namespace, email, value) {
  const safeNamespace = String(namespace || "").trim().toLowerCase();
  const context = buildSecretContext(email, safeNamespace);
  if (!value || typeof value !== "object") {
    return {};
  }
  const clone = JSON.parse(JSON.stringify(value));
  if (safeNamespace === "userapis") {
    const source = Array.isArray(clone) ? clone : Array.isArray(clone.apis) ? clone.apis : [];
    const apis = source.map((entry) => protectApiEntry(entry, context));
    return Array.isArray(clone) ? apis : { ...clone, apis };
  }
  if (safeNamespace === "userocrapi") {
    if (clone.api && typeof clone.api === "object") {
      return { ...clone, api: protectApiEntry(clone.api, context) };
    }
    return protectApiEntry(clone, context);
  }
  if (safeNamespace === "settings") {
    const fields = ["webSearchApiKey"];
    for (const field of fields) {
      if (String(clone[field] || "").trim()) {
        clone[field] = encryptSecret(clone[field], context);
      }
    }
    for (const field of ["webSearchTavilyKeys", "webSearchSerperKeys"]) {
      if (Array.isArray(clone[field])) {
        clone[field] = clone[field]
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .map((item) => encryptSecret(item, context));
      }
    }
    return clone;
  }
  return clone;
}

function sanitizeSystemServiceConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const sanitizeList = (service, items) => (Array.isArray(items) ? items : [])
    .map((entry, index) => {
      const provider = normalizeProvider(entry?.provider);
      if (!SERVICE_PROVIDERS[service]?.includes(provider)) {
        return null;
      }
      return {
        ...entry,
        provider,
        key: SYSTEM_KEY_MARKER,
        keySource: "system",
        viaBackend: true,
        backendProxy: true,
        model: String(entry?.model || getSystemModel(service, provider)).trim(),
        endpoint: String(entry?.endpoint || getSystemEndpoint(service, provider)).trim(),
        enabled: entry?.enabled !== false,
        order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : index
      };
    })
    .filter(Boolean);
  return {
    multiApiMode: source.multiApiMode !== false,
    chatApis: sanitizeList("chat", source.chatApis),
    ocrApis: sanitizeList("ocr", source.ocrApis),
    asrApis: sanitizeList("asr", source.asrApis),
    imageApis: sanitizeList("image", source.imageApis),
    webSearch: {
      tavily: getSystemApiKey("webSearch", "tavily") ? [SYSTEM_KEY_MARKER] : [],
      serper: getSystemApiKey("webSearch", "serper") ? [SYSTEM_KEY_MARKER] : [],
      backendProxy: true,
      keySource: "system"
    }
  };
}

function resolveRequestApiKey(req, service, provider) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const keySource = String(body.keySource || body.api?.keySource || "system").trim().toLowerCase();
  if (keySource === "system" || keySource === "env") {
    const key = getSystemApiKey(service, provider);
    if (!key) {
      throw new Error(`${provider} ${service} API is not configured on the server.`);
    }
    return key;
  }
  const encryptedKey = String(body.key || body.api?.key || "").trim();
  const namespace = String(body.keyNamespace || body.api?.keyNamespace || defaultNamespaceForService(service)).trim().toLowerCase();
  const context = buildSecretContext(req.user?.email || body.email || "", namespace);
  const key = decryptSecret(encryptedKey, context);
  if (!key) {
    throw new Error(`${provider} BYOK API key is not configured for this user.`);
  }
  return key;
}

function defaultNamespaceForService(service) {
  if (service === "ocr") {
    return "userocrapi";
  }
  if (service === "webSearch") {
    return "settings";
  }
  return "userapis";
}

function sanitizeEndpoint(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = new URL(raw);
    return /^https:$/i.test(parsed.protocol) ? raw : fallback;
  } catch (_error) {
    return fallback;
  }
}

function textOnlyMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: String(message?.role || "user").trim() || "user",
    content: Array.isArray(message?.content)
      ? message.content.map((part) => typeof part === "string" ? part : part?.text || "").join("\n")
      : String(message?.content || "")
  }));
}

function toGeminiContents(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => message?.role !== "system").map((message) => ({
    role: message?.role === "assistant" ? "model" : "user",
    parts: [{ text: Array.isArray(message?.content) ? message.content.map((part) => part?.text || "").join("\n") : String(message?.content || "") }]
  }));
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamProviderResponse(response, provider, res) {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`${provider} ${response.status}${detail ? ` ${detail.slice(0, 240)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  if (!response.body) {
    throw new Error(`${provider} stream body missing.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      let json = null;
      try {
        json = JSON.parse(data);
      } catch (_error) {
        continue;
      }
      const normalized = extractChatChunk(provider, json);
      if (normalized.content) {
        sendSse(res, normalized);
      }
    }
  }
  sendSse(res, { done: true });
  res.end();
}

function extractChatChunk(provider, json) {
  const safeProvider = normalizeProvider(provider);
  if (safeProvider === "anthropic") {
    const text = json?.delta?.text || json?.delta?.thinking || "";
    return { kind: json?.delta?.thinking ? "thinking" : "response", content: String(text || "") };
  }
  if (safeProvider === "gemini") {
    const text = (json?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || "").join("");
    return { kind: "response", content: String(text || "") };
  }
  const delta = json?.choices?.[0]?.delta || {};
  const content = delta.content || delta.reasoning_content || delta.reasoning || "";
  return { kind: delta.reasoning_content || delta.reasoning ? "thinking" : "response", content: String(content || "") };
}

async function proxyChat(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const provider = normalizeProvider(body.provider || body.api?.provider || "openai");
  const upstreamProvider = getSystemProvider("chat", provider);
  const key = resolveRequestApiKey(req, "chat", provider);
  const model = String(body.model || body.api?.model || getSystemModel("chat", provider)).trim();
  const endpoint = sanitizeEndpoint(body.endpoint || body.api?.endpoint, getSystemEndpoint("chat", provider));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  if (upstreamProvider === "gemini") {
    const url = new URL(endpoint || DEFAULT_CHAT_ENDPOINTS.gemini);
    url.pathname = `/v1beta/models/${encodeURIComponent(model || DEFAULT_CHAT_MODELS.gemini)}:streamGenerateContent`;
    url.searchParams.set("key", key);
    url.searchParams.set("alt", "sse");
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: toGeminiContents(messages), generationConfig: { maxOutputTokens: 4096 } })
    });
    return streamProviderResponse(response, upstreamProvider, res);
  }

  if (upstreamProvider === "anthropic") {
    const systemMessage = messages.find((message) => message?.role === "system");
    const response = await fetch(endpoint || DEFAULT_CHAT_ENDPOINTS.anthropic, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: model || DEFAULT_CHAT_MODELS.anthropic,
        max_tokens: 4096,
        stream: true,
        messages: textOnlyMessages(messages.filter((message) => message?.role !== "system")),
        system: systemMessage ? String(systemMessage.content || "") : undefined
      })
    });
    return streamProviderResponse(response, upstreamProvider, res);
  }

  const isNvidiaDeepSeek = upstreamProvider === "nvidia_deepseek";
  const response = await fetch(endpoint || DEFAULT_CHAT_ENDPOINTS[provider] || DEFAULT_CHAT_ENDPOINTS[upstreamProvider] || DEFAULT_CHAT_ENDPOINTS.openai, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(upstreamProvider === "openrouter" ? { "HTTP-Referer": "https://faizanai.app", "X-Title": "FaizanAI" } : {})
    },
    body: JSON.stringify({
      model: model || DEFAULT_CHAT_MODELS[provider] || DEFAULT_CHAT_MODELS.openai,
      messages: upstreamProvider === "deepseek" ? textOnlyMessages(messages) : messages,
      stream: true,
      max_tokens: isNvidiaDeepSeek ? 16384 : upstreamProvider === "deepseek" ? 2048 : 4096,
      ...(isNvidiaDeepSeek ? {
        temperature: 1,
        top_p: 0.95,
        chat_template_kwargs: {
          thinking: Boolean(body.deepThink || body.thinking)
        }
      } : {})
    })
  });
  return streamProviderResponse(response, upstreamProvider, res);
}

async function proxyOcr(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const provider = normalizeProvider(body.provider || body.api?.provider || "ocrspace");
  const upstreamProvider = getSystemProvider("ocr", provider);
  const key = resolveRequestApiKey(req, "ocr", provider);
  const base64Image = String(body.base64Image || body.image || "").trim();
  if (!base64Image) {
    throw new Error("OCR image payload is required.");
  }
  if (upstreamProvider === "ocrspace") {
    const form = new FormData();
    form.append("base64Image", base64Image);
    form.append("language", String(body.language || "eng"));
    form.append("isOverlayRequired", "false");
    const response = await fetch(sanitizeEndpoint(body.endpoint || body.api?.endpoint, getSystemEndpoint("ocr", provider) || DEFAULT_OCR_ENDPOINTS.ocrspace), {
      method: "POST",
      headers: { apikey: key },
      body: form
    });
    if (!response.ok) {
      throw new Error(`OCR.Space ${response.status}`);
    }
    const json = await response.json();
    const text = String(json?.ParsedResults?.[0]?.ParsedText || "").trim();
    res.json({ ok: true, text });
    return;
  }
  const endpoint = sanitizeEndpoint(body.endpoint || body.api?.endpoint, getSystemEndpoint("ocr", provider) || DEFAULT_OCR_ENDPOINTS.nvidia);
  const model = String(body.model || body.api?.model || getSystemModel("ocr", provider) || DEFAULT_OCR_MODELS.nvidia).trim();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: base64Image } }] }] })
  });
  if (!response.ok) {
    throw new Error(`NVIDIA OCR ${response.status}`);
  }
  const json = await response.json();
  const text = String(json?.choices?.[0]?.message?.content || json?.data?.[0]?.text || json?.result?.text || json?.text || "").trim();
  res.json({ ok: true, text });
}

async function proxyWebSearch(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const provider = normalizeProvider(body.provider || "tavily");
  const key = resolveRequestApiKey(req, "webSearch", provider);
  const query = String(body.query || "").trim();
  const resultLimit = Math.max(1, Math.min(10, Number(body.resultLimit) || 5));
  if (!query) {
    res.json({ ok: true, results: [] });
    return;
  }
  if (provider === "serper") {
    const response = await fetch(DEFAULT_WEB_ENDPOINTS.serper, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": key },
      body: JSON.stringify({ q: query, num: resultLimit, autocorrect: true })
    });
    if (!response.ok) {
      throw new Error(`Serper ${response.status}`);
    }
    res.json({ ok: true, provider, raw: await response.json() });
    return;
  }
  const response = await fetch(DEFAULT_WEB_ENDPOINTS.tavily, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: resultLimit, search_depth: body.searchDepth || "basic", include_answer: true })
  });
  if (!response.ok) {
    throw new Error(`Tavily ${response.status}`);
  }
  res.json({ ok: true, provider, raw: await response.json() });
}

async function proxyImage(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const provider = normalizeProvider(body.provider || body.api?.provider || "nvidia");
  const key = resolveRequestApiKey(req, "image", provider);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    throw new Error("Image prompt is required.");
  }
  const endpoint = sanitizeEndpoint(body.endpoint || body.api?.endpoint, getSystemEndpoint("image", provider));
  const model = String(body.model || body.api?.model || getSystemModel("image", provider)).trim();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024" })
  });
  if (!response.ok) {
    throw new Error(`Image generation ${response.status}`);
  }
  const json = await response.json();
  res.json({ ok: true, raw: json });
}

async function proxyAsr(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const provider = normalizeProvider(body.provider || body.api?.provider || "nvidia");
  const key = resolveRequestApiKey(req, "asr", provider);
  const encodedAudio = String(body.base64Audio || "").trim();
  if (!encodedAudio) {
    throw new Error("Audio payload is required.");
  }
  const buffer = Buffer.from(encodedAudio.split(",").pop(), "base64");
  const blob = new Blob([buffer], { type: String(body.mimeType || "audio/webm") });
  const form = new FormData();
  form.append("file", blob, "voice.webm");
  form.append("model", String(body.model || body.api?.model || getSystemModel("asr", provider)).trim());
  const response = await fetch(sanitizeEndpoint(body.endpoint || body.api?.endpoint, getSystemEndpoint("asr", provider)), {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form
  });
  if (!response.ok) {
    throw new Error(`ASR ${response.status}`);
  }
  const json = await response.json();
  res.json({ ok: true, text: String(json?.text || json?.transcript || json?.data?.text || "").trim() });
}

async function handleProviderProxyRequest(req, res) {
  try {
    const service = normalizeService(req.params?.service || req.body?.service || "");
    if (service === "chat") {
      await proxyChat(req, res);
      return;
    }
    if (service === "ocr") {
      await proxyOcr(req, res);
      return;
    }
    if (service === "webSearch") {
      await proxyWebSearch(req, res);
      return;
    }
    if (service === "image") {
      await proxyImage(req, res);
      return;
    }
    if (service === "asr") {
      await proxyAsr(req, res);
      return;
    }
    res.status(400).json({ ok: false, error: "Unsupported provider proxy service." });
  } catch (error) {
    if (!res.headersSent) {
      res.status(Number(error?.status || 500)).json({ ok: false, error: error?.message || "Provider proxy failed." });
      return;
    }
    sendSse(res, { error: error?.message || "Provider proxy failed." });
    res.end();
  }
}

module.exports = {
  SYSTEM_KEY_MARKER,
  buildSystemApiCapabilities,
  protectUserStatePayload,
  sanitizeSystemServiceConfig,
  decryptSecret,
  encryptSecret,
  handleProviderProxyRequest
};
