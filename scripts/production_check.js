#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const dotenv = require("dotenv");

const backendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendRoot, "..");
const frontendRoot = path.join(repoRoot, "frontend");
const args = new Set(process.argv.slice(2));
const strictEnv = args.has("--strict-env") || String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
const checks = [];

dotenv.config({ path: path.join(backendRoot, ".env") });

function add(status, name, detail) {
  checks.push({ status, name, detail });
}

function pass(name, detail) {
  add("PASS", name, detail);
}

function warn(name, detail) {
  add("WARN", name, detail);
}

function fail(name, detail) {
  add("FAIL", name, detail);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function walk(dir, options = {}) {
  const out = [];
  const exclude = new Set(options.exclude || []);
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (exclude.has(entry.name)) {
        continue;
      }
      out.push(...walk(full, options));
      continue;
    }
    if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function rel(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) {
    pass("Node runtime", `Node ${process.versions.node} satisfies >=20.`);
    return;
  }
  fail("Node runtime", `Node ${process.versions.node} is below required >=20.`);
}

function checkJsonFiles() {
  const files = [
    path.join(backendRoot, "package.json"),
    path.join(frontendRoot, "manifest.json")
  ];
  for (const filePath of files) {
    try {
      readJson(filePath);
      pass("JSON parse", `${rel(filePath)} is valid JSON.`);
    } catch (error) {
      fail("JSON parse", `${rel(filePath)} is invalid: ${error.message}`);
    }
  }
}

function checkJavaScriptSyntax() {
  const files = [
    ...walk(backendRoot, { exclude: ["node_modules"] }),
    ...walk(frontendRoot, { exclude: ["node_modules", ".next", "assets"] })
  ].filter((filePath) => filePath.endsWith(".js"));

  let failures = 0;
  for (const filePath of files) {
    const result = spawnSync(process.execPath, ["--check", filePath], {
      encoding: "utf8",
      stdio: "pipe"
    });
    if (result.status !== 0) {
      failures += 1;
      fail("JavaScript syntax", `${rel(filePath)} failed syntax check: ${(result.stderr || result.stdout || "").trim()}`);
    }
  }

  if (failures === 0) {
    pass("JavaScript syntax", `${files.length} JavaScript files passed node --check.`);
  }
}

function checkManifest() {
  let manifest;
  try {
    manifest = readJson(path.join(frontendRoot, "manifest.json"));
  } catch (error) {
    fail("Extension manifest", error.message);
    return;
  }

  if (manifest.manifest_version === 3) {
    pass("Extension manifest", "Manifest V3 is configured.");
  } else {
    fail("Extension manifest", "Manifest must use manifest_version 3.");
  }

  const requiredPaths = [
    manifest.action?.default_popup,
    manifest.side_panel?.default_path,
    manifest.background?.service_worker,
    ...(manifest.content_scripts || []).flatMap((item) => [...(item.js || []), ...(item.css || [])])
  ].filter(Boolean);

  for (const item of requiredPaths) {
    const filePath = path.join(frontendRoot, item);
    if (fs.existsSync(filePath)) {
      continue;
    }
    fail("Extension manifest", `Missing manifest asset: ${item}`);
  }

  if ((manifest.host_permissions || []).includes("<all_urls>")) {
    warn("Extension permissions", "<all_urls> is present. Keep Chrome Web Store justification ready for page OCR/exam content scripts.");
  } else {
    pass("Extension permissions", "Host permissions are not globally broad.");
  }

  pass("Extension manifest", `${requiredPaths.length} referenced extension assets checked.`);
}

function checkRemoteExtensionAssets() {
  const htmlFiles = walk(frontendRoot, { exclude: ["node_modules", ".next"] })
    .filter((filePath) => filePath.endsWith(".html"));
  const offenders = [];
  const remoteTag = /<(?:script|link)\b[^>]+(?:src|href)=["']https?:\/\//gi;
  for (const filePath of htmlFiles) {
    const text = fs.readFileSync(filePath, "utf8");
    if (remoteTag.test(text)) {
      offenders.push(rel(filePath));
    }
  }
  if (offenders.length) {
    fail("Remote extension assets", `Remote script/link assets found in: ${offenders.join(", ")}`);
    return;
  }
  pass("Remote extension assets", "No remote script/link assets found in extension HTML files.");
}

function checkEnvTemplate() {
  const envExample = path.join(backendRoot, ".env.example");
  if (!fs.existsSync(envExample)) {
    fail("Environment template", "backend/.env.example is missing.");
    return;
  }
  const text = fs.readFileSync(envExample, "utf8");
  const requiredNames = [
    "NODE_ENV",
    "PORT",
    "PUBLIC_BASE_URL",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CORS_ORIGINS",
    "CHROME_EXTENSION_ORIGINS"
  ];
  const missing = requiredNames.filter((name) => !new RegExp(`^${name}=`, "m").test(text));
  if (missing.length) {
    fail("Environment template", `Missing keys in .env.example: ${missing.join(", ")}`);
  } else {
    pass("Environment template", "Required production keys are documented in backend/.env.example.");
  }
}

function getEnv(name) {
  return String(process.env[name] || "").trim();
}

function isHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function hasChromeExtensionOrigin(value) {
  return String(value || "")
    .split(/\r?\n|,/g)
    .some((item) => item.trim().startsWith("chrome-extension://"));
}

function checkStrictProductionEnv() {
  if (!strictEnv) {
    warn("Production env", "Strict environment validation skipped. Run npm run check:env:production with production secrets configured before deployment.");
    return;
  }

  const required = [
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY"
  ];
  const missing = required.filter((name) => !getEnv(name));
  if (missing.length) {
    fail("Production env", `Missing required production env vars: ${missing.join(", ")}`);
  } else {
    pass("Production env", "Required Razorpay and Supabase env vars are present.");
  }

  if (getEnv("NODE_ENV") === "production") {
    pass("Production env", "NODE_ENV=production is set.");
  } else {
    fail("Production env", "NODE_ENV must be production for deployment.");
  }

  if (isHttpsUrl(getEnv("PUBLIC_BASE_URL"))) {
    pass("Production env", "PUBLIC_BASE_URL is HTTPS.");
  } else {
    fail("Production env", "PUBLIC_BASE_URL must be an HTTPS URL.");
  }

  if (hasChromeExtensionOrigin(getEnv("CORS_ORIGINS")) || hasChromeExtensionOrigin(getEnv("CHROME_EXTENSION_ORIGINS"))) {
    pass("Production env", "Published Chrome extension origin is configured for CORS.");
  } else {
    fail("Production env", "CORS_ORIGINS or CHROME_EXTENSION_ORIGINS must include chrome-extension://<published-extension-id>.");
  }
}

function checkPackageScripts() {
  let pkg;
  try {
    pkg = readJson(path.join(backendRoot, "package.json"));
  } catch (error) {
    fail("Package scripts", error.message);
    return;
  }
  const scripts = pkg.scripts || {};
  const required = ["start", "test", "check:release", "check:env:production"];
  const missing = required.filter((name) => !scripts[name]);
  if (missing.length) {
    fail("Package scripts", `Missing scripts: ${missing.join(", ")}`);
    return;
  }
  pass("Package scripts", "Release validation scripts are available.");
}

checkNodeVersion();
checkJsonFiles();
checkJavaScriptSyntax();
checkManifest();
checkRemoteExtensionAssets();
checkEnvTemplate();
checkPackageScripts();
checkStrictProductionEnv();

const passCount = checks.filter((item) => item.status === "PASS").length;
const warnCount = checks.filter((item) => item.status === "WARN").length;
const failCount = checks.filter((item) => item.status === "FAIL").length;

console.log("\nThinkPulse Production Check");
console.log("===========================");
console.log(`PASS=${passCount} WARN=${warnCount} FAIL=${failCount}`);
for (const check of checks) {
  console.log(`[${check.status}] ${check.name} - ${check.detail}`);
}

process.exitCode = failCount > 0 ? 1 : 0;
