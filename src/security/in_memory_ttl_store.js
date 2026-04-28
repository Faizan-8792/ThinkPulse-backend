"use strict";

class InMemoryTtlStore {
  constructor(options = {}) {
    this.maxEntries = Math.max(100, Number(options.maxEntries) || 5000);
    this.store = new Map();
    this.sweepIntervalMs = Math.max(1000, Number(options.sweepIntervalMs) || 60000);
    this._sweeper = setInterval(() => {
      this.prune();
    }, this.sweepIntervalMs);
    if (typeof this._sweeper?.unref === "function") {
      this._sweeper.unref();
    }
  }

  now() {
    return Date.now();
  }

  normalizeKey(key) {
    return String(key || "").trim();
  }

  getEntry(key) {
    const safeKey = this.normalizeKey(key);
    if (!safeKey) {
      return null;
    }

    const entry = this.store.get(safeKey);
    if (!entry) {
      return null;
    }

    if (Number(entry.expiresAt || 0) > 0 && Number(entry.expiresAt || 0) <= this.now()) {
      this.store.delete(safeKey);
      return null;
    }

    return entry;
  }

  get(key) {
    const entry = this.getEntry(key);
    return entry ? entry.value : null;
  }

  set(key, value, ttlMs = 0) {
    const safeKey = this.normalizeKey(key);
    if (!safeKey) {
      return value;
    }

    const now = this.now();
    const durationMs = Math.max(0, Number(ttlMs) || 0);
    this.store.set(safeKey, {
      value,
      createdAt: now,
      updatedAt: now,
      expiresAt: durationMs > 0 ? now + durationMs : 0
    });
    this.prune(now);
    return value;
  }

  remember(key, value, ttlMs = 0) {
    const existing = this.getEntry(key);
    if (existing) {
      return {
        stored: false,
        value: existing.value,
        entry: existing
      };
    }

    this.set(key, value, ttlMs);
    return {
      stored: true,
      value,
      entry: this.getEntry(key)
    };
  }

  increment(key, ttlMs = 0, step = 1) {
    const safeKey = this.normalizeKey(key);
    if (!safeKey) {
      return 0;
    }

    const next = Math.max(0, Number(this.get(safeKey) || 0)) + Math.max(1, Number(step) || 1);
    this.set(safeKey, next, ttlMs);
    return next;
  }

  delete(key) {
    const safeKey = this.normalizeKey(key);
    if (!safeKey) {
      return false;
    }
    return this.store.delete(safeKey);
  }

  prune(now = this.now()) {
    for (const [key, entry] of this.store.entries()) {
      if (Number(entry?.expiresAt || 0) > 0 && Number(entry.expiresAt) <= now) {
        this.store.delete(key);
      }
    }

    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (typeof oldestKey === "undefined") {
        break;
      }
      this.store.delete(oldestKey);
    }
  }
}

module.exports = {
  InMemoryTtlStore
};
