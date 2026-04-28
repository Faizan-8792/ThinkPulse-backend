"use strict";

const dns = require("dns").promises;
const net = require("net");
const {
  InMemoryTtlStore
} = require("./in_memory_ttl_store");

const dnsCache = new InMemoryTtlStore({
  maxEntries: 4000,
  sweepIntervalMs: 600000
});

function isLocalHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  return host === "localhost" || host === "host.docker.internal" || host.endsWith(".local");
}

function isPrivateIpv4(address) {
  const safe = String(address || "").trim();
  const parts = safe.split(".").map((entry) => Number(entry));
  if (parts.length !== 4 || parts.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return false;
}

function isPrivateIpv6(address) {
  const safe = String(address || "").trim().toLowerCase();
  return (
    safe === "::1" ||
    safe === "::" ||
    safe.startsWith("fc") ||
    safe.startsWith("fd") ||
    safe.startsWith("fe80:")
  );
}

function isPrivateAddress(address) {
  const family = net.isIP(String(address || "").trim());
  if (family === 4) {
    return isPrivateIpv4(address);
  }
  if (family === 6) {
    return isPrivateIpv6(address);
  }
  return false;
}

async function resolveAddresses(hostname) {
  const safeHost = String(hostname || "").trim().toLowerCase();
  if (!safeHost) {
    return [];
  }

  const cached = dnsCache.get(safeHost);
  if (Array.isArray(cached) && cached.length) {
    return cached;
  }

  try {
    const resolved = await dns.lookup(safeHost, {
      all: true,
      verbatim: true
    });
    const addresses = Array.isArray(resolved)
      ? resolved.map((entry) => String(entry?.address || "").trim()).filter(Boolean)
      : [];
    if (addresses.length) {
      dnsCache.set(safeHost, addresses, 10 * 60 * 1000);
    }
    return addresses;
  } catch (_error) {
    return [];
  }
}

async function assertPublicHttpsEndpoint(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    throw new Error("Endpoint must be a valid URL.");
  }

  if (!/^https:$/i.test(parsed.protocol)) {
    throw new Error("Endpoint must use HTTPS.");
  }

  const hostname = String(parsed.hostname || "").trim().toLowerCase();
  if (!hostname) {
    throw new Error("Endpoint hostname is required.");
  }

  if (isLocalHostname(hostname)) {
    throw new Error("Endpoint cannot target localhost or local network hostnames.");
  }

  if (isPrivateAddress(hostname)) {
    throw new Error("Endpoint cannot target private or loopback IP ranges.");
  }

  const resolvedAddresses = await resolveAddresses(hostname);
  if (resolvedAddresses.some((address) => isPrivateAddress(address))) {
    throw new Error("Endpoint cannot resolve to private or loopback IP ranges.");
  }

  return raw;
}

async function validatePremiumServiceConfigEndpoints(config) {
  const payload = config && typeof config === "object" ? config : {};
  const listNames = ["chatApis", "ocrApis", "asrApis", "imageApis"];

  for (const listName of listNames) {
    const items = Array.isArray(payload[listName]) ? payload[listName] : [];
    for (const item of items) {
      const endpoint = String(item?.endpoint || "").trim();
      if (!endpoint) {
        continue;
      }
      item.endpoint = await assertPublicHttpsEndpoint(endpoint);
    }
  }

  return payload;
}

module.exports = {
  assertPublicHttpsEndpoint,
  validatePremiumServiceConfigEndpoints
};
