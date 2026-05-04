"use strict";

const {
  getGlobalJsonConfig
} = require("../payments/supabase_store");

const crypto = require("crypto");

const SYSTEM_KEY_MARKER = "system-managed";
const ENCRYPTED_PREFIX = "enc:v1:";
const LEGACY_OBFUSCATED_PREFIX = "fzn::";
const PROVIDER_PROXY_VERSION = "superior-deepseek-routing-v6";
const DEFAULT_CHAT_MODELS = {
  openrouter: "openai/gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  openai: "gpt-4o-mini",
  custom: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-20250514",
  deepseek: "deepseek-chat",
  nvidia: "meta/llama-3.1-70b-instruct",
  nvidia_deepseek: "deepseek-ai/deepseek-v4-pro",
  superior_llm: "deepseek-ai/deepseek-v4-pro"
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
const PREMIUM_SERVICE_APIS_SETTING_KEY = "premium_service_apis_v1";
let premiumServiceConfigRuntime = null;
const SERVICE_PROVIDERS = {
  chat: ["superior_llm", "openrouter", "gemini", "openai", "anthropic", "deepseek", "nvidia", "nvidia_deepseek"],
  ocr: ["ocrspace", "nvidia", "superior_ocr"],
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
  ocrspace: ["OCRSPACE_API_KEY", "OCRSPACE_API", "OCR_SPACE_API_KEY", "OCR_SPACE_API", "ADMIN_OCRSPACE_KEY"],
  tavily: ["TAVILY_API_KEY", "TAVILY_API"],
  serper: ["SERPER_API_KEY", "SERPER_API", "GOOGLE_SERPER_API_KEY"]
};

function getServiceEnvAliases(service, provider, suffix = "") {
  const safeService = normalizeService(service);
  const safeProvider = normalizeProvider(provider);
  if (safeService === "ocr" && safeProvider === "ocrspace") {
    return suffix === "API_KEY" || suffix === "API"
      ? ["ADMIN_OCRSPACE_KEY"]
      : suffix === "ENDPOINT"
        ? ["ADMIN_OCRSPACE_ENDPOINT"]
        : [];
  }
  if (safeService === "ocr" && safeProvider === "nvidia") {
    return suffix === "API_KEY" || suffix === "API"
      ? ["ADMIN_NVIDIA_OCR_KEY"]
      : suffix === "ENDPOINT"
        ? ["ADMIN_NVIDIA_OCR_ENDPOINT"]
        : suffix === "MODEL"
          ? ["ADMIN_NVIDIA_OCR_MODEL"]
          : [];
  }
  return [];
}

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

function isSupportedProvider(service, provider) {
  const safeService = normalizeService(service);
  const safeProvider = normalizeProvider(provider);
  return SERVICE_PROVIDERS[safeService]?.includes(safeProvider) === true;
}

function normalizeSystemProvider(service, value, fallback) {
  const configured = normalizeProvider(value);
  if (configured && isSupportedProvider(service, configured)) {
    return configured;
  }
  const safeFallback = normalizeProvider(fallback);
  if (safeFallback && isSupportedProvider(service, safeFallback)) {
    return safeFallback;
  }
  return "";
}

function isNvidiaDeepSeekModel(value) {
  const safe = String(value || "").trim().toLowerCase();
  return safe.includes("deepseek-ai/deepseek") || safe.includes("deepseek-v4") || safe.includes("deepseek-r1");
}

function getSystemProvider(service, provider) {
  const safeService = normalizeService(service);
  const safeProvider = normalizeProvider(provider);
  if (safeService === "chat" && safeProvider === "superior_llm") {
    const configured = readEnvAny([
      "SUPERIOR_LLM_PROVIDER",
      "SUPERIOR_LLM_UPSTREAM_PROVIDER",
      "SUPERIOR_LLM_TYPE"
    ]);
    const resolved = normalizeSystemProvider("chat", configured, "nvidia");
    if ((resolved === "nvidia" || resolved === "nvidia_deepseek") && isNvidiaDeepSeekModel(getSystemModel("chat", safeProvider))) {
      return "nvidia_deepseek";
    }
    return resolved;
  }
  if (safeService === "ocr" && safeProvider === "superior_ocr") {
    return normalizeSystemProvider("ocr", readEnvAny([
      "SUPERIOR_OCR_PROVIDER",
      "SUPERIOR_OCR_UPSTREAM_PROVIDER",
      "SUPERIOR_OCR_TYPE"
    ]), "nvidia");
  }
  return normalizeSystemProvider(safeService, safeProvider, safeProvider);
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

function normalizeApiKey(value) {
  const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "").trim();
  const nvidiaMatch = raw.match(/nvapi-[A-Za-z0-9_-]+/);
  if (nvidiaMatch) {
    return nvidiaMatch[0];
  }
  return raw
    .replace(/^authorization\s*:\s*bearer\s+/i, "")
    .replace(/^bearer\s+/i, "")
    .replace(/^api_key\s*=\s*/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function sanitizeKeyList(value, maxItems = 50) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/\r?\n|,/g)
        .map((item) => item.trim());
  const seen = new Set();
  const output = [];
  for (const raw of source) {
    const key = normalizeApiKey(raw);
    if (!key || key === SYSTEM_KEY_MARKER || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(key);
    if (output.length >= maxItems) {
      break;
    }
  }
  return output;
}

function setPremiumServiceConfigRuntime(value) {
  premiumServiceConfigRuntime = value && typeof value === "object" ? value : null;
}

async function ensurePremiumServiceConfigRuntime() {
  if (premiumServiceConfigRuntime && typeof premiumServiceConfigRuntime === "object") {
    return premiumServiceConfigRuntime;
  }
  const stored = await getGlobalJsonConfig(PREMIUM_SERVICE_APIS_SETTING_KEY).catch(() => null);
  premiumServiceConfigRuntime = stored?.found && stored.value && typeof stored.value === "object"
    ? stored.value
    : {};
  return premiumServiceConfigRuntime;
}

function getRuntimeWebSearchKeys(provider) {
  const safeProvider = normalizeProvider(provider);
  if (safeProvider !== "tavily" && safeProvider !== "serper") {
    return [];
  }
  const source = premiumServiceConfigRuntime && typeof premiumServiceConfigRuntime === "object"
    ? premiumServiceConfigRuntime
    : {};
  const webSearch = source.webSearch && typeof source.webSearch === "object" ? source.webSearch : {};
  return sanitizeKeyList(webSearch[safeProvider] || []);
}

async function resolveSystemWebSearchApiKey(provider) {
  const storedKeys = getRuntimeWebSearchKeys(provider);
  if (storedKeys.length) {
    return storedKeys[0];
  }
  await ensurePremiumServiceConfigRuntime();
  return getRuntimeWebSearchKeys(provider)[0] || getResolvedSystemApiKey("webSearch", provider);
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
    ...getServiceEnvAliases(service, safeProvider, "API_KEY"),
    ...getServiceEnvAliases(service, safeProvider, "API"),
    ...(ENV_ALIASES[safeProvider] || [])
  ];
  return normalizeApiKey(readEnvAny(names));
}

function getResolvedSystemApiKey(service, provider) {
  const safeService = normalizeService(service);
  const safeProvider = normalizeProvider(provider);
  const primary = getSystemApiKey(safeService, safeProvider);
  if (primary) {
    return primary;
  }
  const upstreamProvider = getSystemProvider(safeService, safeProvider);
  if (upstreamProvider && upstreamProvider !== safeProvider) {
    const upstreamKey = getSystemApiKey(safeService, upstreamProvider);
    if (upstreamKey) {
      return upstreamKey;
    }
  }
  if (
    safeService === "chat" &&
    (safeProvider === "nvidia" || safeProvider === "nvidia_deepseek")
  ) {
    const superiorKey = getSystemApiKey(safeService, "superior_llm");
    if (superiorKey) {
      return superiorKey;
    }
  }
  return "";
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
  return readEnvAny([
    ...buildEnvNames(safeService, safeProvider, "MODEL"),
    ...getServiceEnvAliases(safeService, safeProvider, "MODEL")
  ]) || defaults[safeProvider] || "";
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
  const fallback = defaults[safeProvider] || "";
  return sanitizeEndpoint(readEnvAny([
    ...buildEnvNames(safeService, safeProvider, "ENDPOINT"),
    ...getServiceEnvAliases(safeService, safeProvider, "ENDPOINT")
  ]), fallback);
}

function buildProxyEntry(service, provider, order = 0) {
  const safeService = normalizeService(service);
  const safeProvider = normalizeProvider(provider);
  if (!getResolvedSystemApiKey(safeService, safeProvider)) {
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

function buildProviderProxyDiagnostics() {
  const superiorProvider = "superior_llm";
  const superiorUpstreamProvider = getSystemProvider("chat", superiorProvider);
  const superiorModel = getSystemModel("chat", superiorProvider);
  const superiorEndpoint = resolveChatEndpoint(
    superiorUpstreamProvider,
    getSystemEndpoint("chat", superiorProvider),
    DEFAULT_CHAT_ENDPOINTS[superiorUpstreamProvider] || DEFAULT_CHAT_ENDPOINTS[superiorProvider]
  );
  const superiorDirectKeyConfigured = Boolean(getSystemApiKey("chat", superiorProvider));
  const superiorUpstreamKeyConfigured = superiorUpstreamProvider && superiorUpstreamProvider !== superiorProvider
    ? Boolean(getSystemApiKey("chat", superiorUpstreamProvider))
    : false;
  const ocrCapabilities = buildSystemApiCapabilities().ocrApis || [];
  return {
    version: PROVIDER_PROXY_VERSION,
    chat: {
      superior_llm: {
        keyConfigured: Boolean(getResolvedSystemApiKey("chat", superiorProvider)),
        directKeyConfigured: superiorDirectKeyConfigured,
        upstreamKeyConfigured: superiorUpstreamKeyConfigured,
        upstreamProvider: superiorUpstreamProvider,
        model: superiorModel,
        endpoint: superiorEndpoint,
        deepSeekModel: isNvidiaDeepSeekModel(superiorModel)
      },
      nvidia: {
        keyConfigured: Boolean(getSystemApiKey("chat", "nvidia"))
      },
      nvidia_deepseek: {
        keyConfigured: Boolean(getSystemApiKey("chat", "nvidia_deepseek"))
      }
    },
    ocr: {
      order: ocrCapabilities.map((api) => api.provider),
      ocrspace: {
        keyConfigured: Boolean(getSystemApiKey("ocr", "ocrspace")),
        endpoint: getSystemEndpoint("ocr", "ocrspace")
      },
      nvidia: {
        keyConfigured: Boolean(getSystemApiKey("ocr", "nvidia")),
        endpoint: getSystemEndpoint("ocr", "nvidia"),
        model: getSystemModel("ocr", "nvidia")
      },
      superior_ocr: {
        keyConfigured: Boolean(getResolvedSystemApiKey("ocr", "superior_ocr")),
        directKeyConfigured: Boolean(getSystemApiKey("ocr", "superior_ocr")),
        upstreamProvider: getSystemProvider("ocr", "superior_ocr"),
        endpoint: getSystemEndpoint("ocr", "superior_ocr"),
        model: getSystemModel("ocr", "superior_ocr")
      }
    }
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

function sanitizeSystemServiceConfig(value, options = {}) {
  const source = value && typeof value === "object" ? value : {};
  const webSearchSource = source.webSearch && typeof source.webSearch === "object" ? source.webSearch : {};
  const configuredTavily = sanitizeKeyList(webSearchSource.tavily || []);
  const configuredSerper = sanitizeKeyList(webSearchSource.serper || []);
  const preserveWebSearchKeys = Boolean(options?.preserveWebSearchKeys);
  const sanitizeList = (service, items) => (Array.isArray(items) ? items : [])
    .map((entry, index) => {
      const provider = normalizeProvider(entry?.provider);
      if (!SERVICE_PROVIDERS[service]?.includes(provider)) {
        return null;
      }
      if (!getResolvedSystemApiKey(service, provider)) {
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
      tavily: preserveWebSearchKeys
        ? configuredTavily
        : (getSystemApiKey("webSearch", "tavily") || configuredTavily.length ? [SYSTEM_KEY_MARKER] : []),
      serper: preserveWebSearchKeys
        ? configuredSerper
        : (getSystemApiKey("webSearch", "serper") || configuredSerper.length ? [SYSTEM_KEY_MARKER] : []),
      backendProxy: true,
      keySource: "system"
    }
  };
}

function resolveRequestApiKey(req, service, provider) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const keySource = String(body.keySource || body.api?.keySource || "system").trim().toLowerCase();
  if (keySource === "system" || keySource === "env") {
    const key = getResolvedSystemApiKey(service, provider);
    if (!key) {
      throw new Error(`${provider} ${service} API is not configured on the server.`);
    }
    return normalizeApiKey(key);
  }
  const encryptedKey = String(body.key || body.api?.key || "").trim();
  const namespace = String(body.keyNamespace || body.api?.keyNamespace || defaultNamespaceForService(service)).trim().toLowerCase();
  const context = buildSecretContext(req.user?.email || body.email || "", namespace);
  const key = decryptSecret(encryptedKey, context);
  if (!key) {
    throw new Error(`${provider} BYOK API key is not configured for this user.`);
  }
  return normalizeApiKey(key);
}

function buildProviderProxyForbiddenError(message) {
  const error = new Error(message || "Provider proxy access is not allowed.");
  error.status = 403;
  error.source = "provider_proxy_auth";
  return error;
}

function isSystemManagedProxyRequest(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const keySource = String(body.keySource || body.api?.keySource || "system").trim().toLowerCase();
  return keySource === "system" || keySource === "env";
}

function assertProviderProxyAccess(req) {
  if (!isSystemManagedProxyRequest(req)) {
    return;
  }

  const role = String(req.user?.role || "").trim().toLowerCase();
  if (role === "admin" || role === "premium") {
    return;
  }

  const extensionId = String(req.headers["x-thinkpulse-extension-id"] || "").trim();
  if (!extensionId) {
    throw buildProviderProxyForbiddenError("Extension runtime authorization required for managed provider proxy.");
  }
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

function resolveChatEndpoint(upstreamProvider, endpoint, fallback) {
  const safeProvider = normalizeProvider(upstreamProvider);
  const safeFallback = fallback || DEFAULT_CHAT_ENDPOINTS[safeProvider] || DEFAULT_CHAT_ENDPOINTS.openai;
  const safeEndpoint = sanitizeEndpoint(endpoint, safeFallback);
  if (safeProvider === "nvidia" || safeProvider === "nvidia_deepseek") {
    try {
      const parsed = new URL(safeEndpoint);
      if (!/\/chat\/completions\/?$/i.test(parsed.pathname)) {
        return DEFAULT_CHAT_ENDPOINTS[safeProvider] || DEFAULT_CHAT_ENDPOINTS.nvidia;
      }
    } catch (_error) {
      return DEFAULT_CHAT_ENDPOINTS[safeProvider] || DEFAULT_CHAT_ENDPOINTS.nvidia;
    }
  }
  return safeEndpoint;
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

function prepareSseResponse(res) {
  if (res.__providerProxySsePrepared) {
    return () => {};
  }
  res.__providerProxySsePrepared = true;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  sendSse(res, { kind: "retry", content: "" });
  const heartbeatId = setInterval(() => {
    try {
      if (!res.writableEnded && !res.destroyed) {
        sendSse(res, { kind: "retry", content: "" });
      }
    } catch (_error) {
      clearInterval(heartbeatId);
    }
  }, 15000);
  return () => clearInterval(heartbeatId);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableProviderStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

async function fetchWithProviderTimeout(endpoint, options, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(endpoint, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    const failure = new Error(error?.name === "AbortError" ? "Upstream provider request timed out." : error?.message || "Upstream provider request failed.");
    failure.status = error?.name === "AbortError" ? 504 : 502;
    failure.source = "provider_fetch";
    throw failure;
  } finally {
    clearTimeout(timeoutId);
  }
}

function sanitizeProviderErrorDetail(value) {
  return String(value || "")
    .replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-***")
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function buildProviderHttpError(provider, response, detail) {
  const status = Number(response?.status || 502);
  const contentType = sanitizeProviderErrorDetail(response?.headers?.get?.("content-type") || "");
  const requestId = sanitizeProviderErrorDetail(
    response?.headers?.get?.("x-request-id") ||
    response?.headers?.get?.("x-nv-request-id") ||
    response?.headers?.get?.("x-ms-request-id") ||
    response?.headers?.get?.("x-azure-ref") ||
    ""
  );
  const safeDetail = sanitizeProviderErrorDetail(detail);
  const meta = [
    `source=upstream`,
    contentType ? `contentType=${contentType}` : "",
    requestId ? `requestId=${requestId}` : ""
  ].filter(Boolean).join(" ");
  const error = new Error(`${provider} ${status}${meta ? ` ${meta}` : ""}${safeDetail ? ` ${safeDetail}` : ""}`);
  error.status = status;
  error.provider = provider;
  error.source = "upstream";
  return error;
}

async function fetchProviderResponse(endpoint, options, provider) {
  const safeProvider = normalizeProvider(provider);
  const attempts = safeProvider === "nvidia_deepseek" ? 3 : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithProviderTimeout(endpoint, options);
      if (!isRetriableProviderStatus(response.status) || attempt >= attempts) {
        return response;
      }
      const detail = await response.text().catch(() => "");
      lastError = buildProviderHttpError(safeProvider, response, detail);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetriableProviderStatus(Number(error?.status || 502))) {
        throw error;
      }
    }
    await delay(400 * attempt);
  }
  throw lastError || new Error(`${safeProvider} provider request failed.`);
}

async function streamProviderResponse(response, provider, res) {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw buildProviderHttpError(provider, response, detail);
  }
  if (!response.body) {
    throw new Error(`${provider} stream body missing.`);
  }
  const stopHeartbeat = prepareSseResponse(res);
  try {
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
  } finally {
    stopHeartbeat();
  }
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
  const isSuperiorLlm = provider === "superior_llm";
  const systemModel = getSystemModel("chat", provider);
  const systemEndpoint = getSystemEndpoint("chat", provider);
  const model = String(isSuperiorLlm ? systemModel : body.model || body.api?.model || systemModel).trim();
  const endpoint = resolveChatEndpoint(upstreamProvider, isSuperiorLlm ? systemEndpoint : body.endpoint || body.api?.endpoint, DEFAULT_CHAT_ENDPOINTS[upstreamProvider] || systemEndpoint);
  const messages = Array.isArray(body.messages) ? body.messages : [];

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
  const chatEndpoint = endpoint || DEFAULT_CHAT_ENDPOINTS[provider] || DEFAULT_CHAT_ENDPOINTS[upstreamProvider] || DEFAULT_CHAT_ENDPOINTS.openai;
  const requestMessages = upstreamProvider === "deepseek" || isNvidiaDeepSeek ? textOnlyMessages(messages) : messages;
  const stopHeartbeat = isNvidiaDeepSeek ? prepareSseResponse(res) : null;
  try {
    const response = await fetchProviderResponse(chatEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": "OpenAI/JS FaizanAI-ThinkPulse",
        ...(upstreamProvider === "openrouter" ? { "HTTP-Referer": "https://faizanai.app", "X-Title": "FaizanAI" } : {})
      },
      body: JSON.stringify({
        model: model || DEFAULT_CHAT_MODELS[provider] || DEFAULT_CHAT_MODELS.openai,
        messages: requestMessages,
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
    }, upstreamProvider);
    return await streamProviderResponse(response, upstreamProvider, res);
  } finally {
    if (typeof stopHeartbeat === "function") {
      stopHeartbeat();
    }
  }
}

async function proxyOcr(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const provider = normalizeProvider(body.provider || body.api?.provider || "ocrspace");
  const keySource = String(body.keySource || body.api?.keySource || "system").trim().toLowerCase();
  const isSystemManagedRequest = keySource === "system" || keySource === "env";
  const base64Image = String(body.base64Image || body.image || "").trim();
  if (!base64Image) {
    throw new Error("OCR image payload is required.");
  }
  const candidates = provider === "superior_ocr" || (provider === "nvidia" && isSystemManagedRequest)
    ? ["ocrspace", "nvidia", "superior_ocr"]
    : [provider];
  let lastError = null;
  for (const candidate of candidates) {
    const targetProvider = normalizeProvider(candidate);
    const upstreamProvider = getSystemProvider("ocr", targetProvider);
    const candidateKey = targetProvider === provider
      ? resolveRequestApiKey(req, "ocr", targetProvider)
      : normalizeApiKey(getResolvedSystemApiKey("ocr", targetProvider));
    if (!candidateKey) {
      continue;
    }
    const usesRequestConfig = targetProvider === provider && provider !== "superior_ocr";
    try {
      if (upstreamProvider === "ocrspace") {
        const form = new FormData();
        form.append("base64Image", base64Image);
        form.append("language", String(body.language || "eng"));
        form.append("isOverlayRequired", "false");
        form.append("OCREngine", String(body.ocrEngine || body.OCREngine || "2"));
        const response = await fetch(sanitizeEndpoint(
          usesRequestConfig ? body.endpoint || body.api?.endpoint : "",
          getSystemEndpoint("ocr", targetProvider) || DEFAULT_OCR_ENDPOINTS.ocrspace
        ), {
          method: "POST",
          headers: { apikey: candidateKey },
          body: form
        });
        if (!response.ok) {
          const error = new Error(`OCR.Space ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const json = await response.json();
        const errorMessage = Array.isArray(json?.ErrorMessage)
          ? json.ErrorMessage.filter(Boolean).join(" ")
          : String(json?.ErrorMessage || json?.ErrorDetails || "").trim();
        if (json?.IsErroredOnProcessing || Number(json?.OCRExitCode || 0) >= 3) {
          const error = new Error(errorMessage || "OCR.Space failed to process image.");
          error.status = 422;
          throw error;
        }
        const text = (Array.isArray(json?.ParsedResults) ? json.ParsedResults : [])
          .map((item) => String(item?.ParsedText || "").trim())
          .filter(Boolean)
          .join("\n")
          .trim();
        if (!text) {
          const error = new Error(errorMessage || "OCR.Space returned empty text.");
          error.status = 422;
          throw error;
        }
        res.json({ ok: true, text });
        return;
      }
      const endpoint = sanitizeEndpoint(
        usesRequestConfig ? body.endpoint || body.api?.endpoint : "",
        getSystemEndpoint("ocr", targetProvider) || DEFAULT_OCR_ENDPOINTS.nvidia
      );
      const model = String(
        (usesRequestConfig ? body.model || body.api?.model : "") ||
        getSystemModel("ocr", targetProvider) ||
        DEFAULT_OCR_MODELS.nvidia
      ).trim();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${candidateKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: base64Image } }] }] })
      });
      if (!response.ok) {
        const error = new Error(`NVIDIA OCR ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const json = await response.json();
      const text = String(json?.choices?.[0]?.message?.content || json?.data?.[0]?.text || json?.result?.text || json?.text || "").trim();
      if (!text) {
        const error = new Error("NVIDIA OCR returned empty text.");
        error.status = 422;
        throw error;
      }
      res.json({ ok: true, text });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("OCR provider is not configured on the server.");
}

async function proxyWebSearch(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const provider = normalizeProvider(body.provider || "tavily");
  const keySource = String(body.keySource || body.api?.keySource || "system").trim().toLowerCase();
  const key = keySource === "system" || keySource === "env"
    ? await resolveSystemWebSearchApiKey(provider)
    : resolveRequestApiKey(req, "webSearch", provider);
  if (!key) {
    throw new Error(`${provider} webSearch API is not configured on the server.`);
  }
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
    assertProviderProxyAccess(req);
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
    const payload = {
      ok: false,
      error: error?.message || "Provider proxy failed.",
      status: Number(error?.status || 500),
      source: error?.source || "provider_proxy",
      provider: error?.provider || undefined,
      version: PROVIDER_PROXY_VERSION
    };
    if (!res.headersSent) {
      res.status(Number(error?.status || 500)).json(payload);
      return;
    }
    sendSse(res, { error: payload.error, status: payload.status, source: payload.source, provider: payload.provider, version: payload.version });
    res.end();
  }
}

module.exports = {
  SYSTEM_KEY_MARKER,
  PREMIUM_SERVICE_APIS_SETTING_KEY,
  buildSystemApiCapabilities,
  buildProviderProxyDiagnostics,
  protectUserStatePayload,
  sanitizeSystemServiceConfig,
  setPremiumServiceConfigRuntime,
  decryptSecret,
  encryptSecret,
  handleProviderProxyRequest
};
