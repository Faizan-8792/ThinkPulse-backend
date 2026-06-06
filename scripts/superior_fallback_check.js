"use strict";

/**
 * Verifies superior_llm primary + Nemotron fallback configuration and that the
 * proxy actually streams. Run from backend/: node scripts/superior_fallback_check.js
 *
 * It performs:
 *  1. Config diagnostics check (primary + fallback present).
 *  2. A live primary chat call (DeepSeek) and prints first tokens.
 *  3. A forced-failure run (bad primary key) to prove fallback -> Nemotron.
 */

require("dotenv").config();

const { buildProviderProxyDiagnostics, handleProviderProxyRequest } = require("../src/providers/provider_proxy");

function makeRes() {
  const chunks = [];
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    _chunks: chunks,
    status() { return this; },
    setHeader() {},
    flushHeaders() {},
    write(data) { chunks.push(String(data)); return true; },
    end() { this.writableEnded = true; },
    json(obj) { chunks.push(JSON.stringify(obj)); this.writableEnded = true; }
  };
}

function collectText(res) {
  let text = "";
  let thinking = "";
  for (const raw of res._chunks) {
    for (const line of String(raw).split(/\n/)) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;
      try {
        const json = JSON.parse(payload);
        if (json.kind === "thinking") thinking += json.content || "";
        else if (json.content) text += json.content || "";
      } catch (_) {}
    }
  }
  return { text, thinking };
}

async function runChat(label, bodyOverrides = {}) {
  const req = {
    user: { role: "admin", email: "test@local" },
    headers: { "x-thinkpulse-extension-id": "harness" },
    body: {
      service: "chat",
      provider: "superior_llm",
      keySource: "system",
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
      ...bodyOverrides
    }
  };
  const res = makeRes();
  const started = Date.now();
  try {
    await handleProviderProxyRequest(req, res);
    const { text, thinking } = collectText(res);
    // handleProviderProxyRequest catches errors and writes an error payload
    // instead of throwing, so detect failure from the emitted chunks.
    const errorChunk = res._chunks.find((c) => /"error"/.test(c) && !/"done"/.test(c));
    if (errorChunk && !text) {
      console.log(`\n[${label}] FAILED: ${errorChunk.slice(0, 300)}`);
      return false;
    }
    console.log(`\n[${label}] OK in ${Date.now() - started}ms`);
    console.log(`[${label}] thinking chars: ${thinking.length}`);
    console.log(`[${label}] output: ${text.slice(0, 200) || "(empty)"}`);
    return true;
  } catch (error) {
    console.log(`\n[${label}] FAILED: ${error?.message || error}`);
    return false;
  }
}

(async () => {
  const diag = buildProviderProxyDiagnostics();
  console.log("=== Diagnostics: superior_llm ===");
  console.log(JSON.stringify(diag.chat.superior_llm, null, 2));

  // 1. Live primary (DeepSeek) call.
  await runChat("primary");

  // 2. Force the primary to fail by clobbering the DeepSeek key so the proxy
  //    must fall back to Nemotron. Restore afterwards.
  const savedPrimary = process.env.SUPERIOR_LLM_API;
  process.env.SUPERIOR_LLM_API = "sk-invalid-key-to-force-fallback";
  await runChat("fallback (forced primary failure)");
  process.env.SUPERIOR_LLM_API = savedPrimary;
})();
