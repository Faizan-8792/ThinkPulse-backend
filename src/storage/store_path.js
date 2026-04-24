"use strict";

const path = require("path");

/**
 * Converts unknown values to trimmed strings.
 * @param {unknown} value
 * @returns {string}
 */
function toSafeString(value) {
  return String(value || "").trim();
}

/**
 * Returns true when app likely runs from a managed read-only package mount.
 * Azure App Service exposes these markers in run-from-package deployments.
 * @returns {boolean}
 */
function isManagedReadonlyEnvironment() {
  return [
    process.env.WEBSITE_INSTANCE_ID,
    process.env.WEBSITE_SITE_NAME,
    process.env.WEBSITE_HOSTNAME,
    process.env.WEBSITE_RUN_FROM_PACKAGE,
    process.env.SCM_RUN_FROM_PACKAGE
  ].some((value) => Boolean(toSafeString(value)));
}

/**
 * Resolves writable default root for local JSON stores.
 * @returns {string}
 */
function resolveDefaultDataRoot() {
  const explicitRoot = toSafeString(process.env.THINKPULSE_DATA_DIR || process.env.DATA_DIR);
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const homeDir = toSafeString(process.env.HOME || process.env.USERPROFILE);
  if (homeDir && isManagedReadonlyEnvironment()) {
    return path.resolve(homeDir, "data", "thinkpulse");
  }

  return path.resolve(process.cwd(), "data");
}

/**
 * Resolves final JSON store path.
 * @param {unknown} configuredPath
 * @param {string} fileName
 * @returns {string}
 */
function resolveStorePath(configuredPath, fileName) {
  const explicitPath = toSafeString(configuredPath);
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  return path.resolve(resolveDefaultDataRoot(), toSafeString(fileName));
}

module.exports = {
  resolveDefaultDataRoot,
  resolveStorePath
};
