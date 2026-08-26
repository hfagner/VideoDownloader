// Helpers puros de exibição/decisão compartilhados pelo popup e background.

const Formats = {
  formatBytes(bytes, decimals = 1) {
    if (!+bytes) return "0 Bytes";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(dm)} ${sizes[i]}`;
  },

  formatDuration(seconds) {
    if (!seconds) return null;
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  },

  sizeLabel(size, estimated) {
    if (!size || size <= 0) return "Tamanho indisponível";
    return (estimated ? "≈ " : "") + Formats.formatBytes(size);
  },

  pickBest(formats, bestId) {
    if (!formats || formats.length === 0) return null;
    if (bestId) {
      const byId = formats.find((f) => f.id === bestId);
      if (byId) return byId;
    }
    return formats.find((f) => f.type === "video") || formats[0];
  },

  fallbackTitle(item, analyzedTitle) {
    if (analyzedTitle) return analyzedTitle;
    if (item && item.ogTitle) return item.ogTitle;
    if (item && item.pageTitle) return item.pageTitle;
    if (item && item.filename) return item.filename;
    return "media";
  },

  isDirectFile(item) {
    if (!item || item.isEmbed || item.isBlob || item.type === "stream") return false;
    return !/\.(m3u8|mpd)(\?|#|$)/i.test(item.url || "");
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Formats;
} else if (typeof window !== "undefined") {
  window.Formats = Formats;
}
