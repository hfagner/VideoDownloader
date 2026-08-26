// Status e comunicação com o Motor Local (servidor Flask 127.0.0.1).

const Backend = {
  CANDIDATE_PORTS: [5000, 5001, 5002],
  CACHE_TTL_MS: 30 * 60 * 1000,

  async pingPort(port, timeoutMs = 1500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`, {
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const data = await response.json().catch(() => null);
      return !!(data && data.ok === true && data.service === "edge-video-downloader");
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  },

  async findActivePort(ports = Backend.CANDIDATE_PORTS) {
    for (const port of ports) {
      if (await Backend.pingPort(port)) return port;
    }
    return null;
  },

  isCacheValid(entry, now = Date.now(), ttlMs = Backend.CACHE_TTL_MS) {
    return !!(entry && entry.result && typeof entry.ts === "number" && now - entry.ts < ttlMs);
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Backend;
} else if (typeof window !== "undefined") {
  window.Backend = Backend;
}
