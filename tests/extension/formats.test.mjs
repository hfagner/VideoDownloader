import test from "node:test";
import assert from "node:assert/strict";
import Formats from "../../libs/formats.js";

test("formatBytes formata unidades", () => {
  assert.equal(Formats.formatBytes(0), "0 Bytes");
  assert.equal(Formats.formatBytes(1024), "1.0 KB");
  assert.equal(Formats.formatBytes(220200960), "210.0 MB");
});

test("sizeLabel exato, estimado e indisponível", () => {
  assert.equal(Formats.sizeLabel(220200960, false), "210.0 MB");
  assert.equal(Formats.sizeLabel(95000000, true), "≈ 90.6 MB");
  assert.equal(Formats.sizeLabel(null, false), "Tamanho indisponível");
  assert.equal(Formats.sizeLabel(0, false), "Tamanho indisponível");
});

test("formatDuration mm:ss e h:mm:ss", () => {
  assert.equal(Formats.formatDuration(504), "8:24");
  assert.equal(Formats.formatDuration(4080), "1:08:00");
  assert.equal(Formats.formatDuration(null), null);
});

test("pickBest usa bestId e cai para primeiro vídeo", () => {
  const formats = [
    { id: "h720", type: "video" },
    { id: "h1080", type: "video" },
    { id: "mp3", type: "audio" },
  ];
  assert.equal(Formats.pickBest(formats, "h1080").id, "h1080");
  assert.equal(Formats.pickBest(formats, null).id, "h720");
  assert.equal(Formats.pickBest([{ id: "mp3", type: "audio" }], null).id, "mp3");
  assert.equal(Formats.pickBest([], null), null);
});

test("fallbackTitle segue a cadeia definida na spec", () => {
  const item = { ogTitle: "OG", pageTitle: "Página", filename: "video.mp4" };
  assert.equal(Formats.fallbackTitle(item, "Título real"), "Título real");
  assert.equal(Formats.fallbackTitle(item, null), "OG");
  assert.equal(Formats.fallbackTitle({ pageTitle: "Página" }, null), "Página");
  assert.equal(Formats.fallbackTitle({}, null), "media");
});

test("isDirectFile exclui streams, embeds e blobs", () => {
  assert.equal(Formats.isDirectFile({ url: "https://x/v.mp4", type: "video" }), true);
  assert.equal(Formats.isDirectFile({ url: "https://x/a.m3u8", type: "stream" }), false);
  assert.equal(Formats.isDirectFile({ url: "https://x/master.m3u8?t=1", type: "video" }), false);
  assert.equal(Formats.isDirectFile({ url: "https://x/v.mp4", type: "video", isEmbed: true }), false);
  assert.equal(Formats.isDirectFile({ url: "blob:https://x/1", isBlob: true, type: "video" }), false);
});
