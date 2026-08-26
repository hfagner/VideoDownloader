import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Backend from "../../libs/backend.js";

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("pingPort true para /api/ping ok", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "edge-video-downloader" }));
  });
  try {
    assert.equal(await Backend.pingPort(srv.address().port), true);
  } finally {
    srv.close();
  }
});

test("pingPort false quando serviço não é o nosso", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "outro" }));
  });
  try {
    assert.equal(await Backend.pingPort(srv.address().port), false);
  } finally {
    srv.close();
  }
});

test("findActivePort encontra a porta ativa entre candidatas", async () => {
  const srv = await startServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "edge-video-downloader" }));
  });
  try {
    assert.equal(await Backend.findActivePort([srv.address().port]), srv.address().port);
  } finally {
    srv.close();
  }
});

test("isCacheValid respeita TTL e dados mínimos", () => {
  const entry = { result: { title: "T" }, ts: 1000 };
  assert.equal(Backend.isCacheValid(entry, 1000 + 29 * 60 * 1000), true);
  assert.equal(Backend.isCacheValid(entry, 1000 + 31 * 60 * 1000), false);
  assert.equal(Backend.isCacheValid(null, 1000), false);
  assert.equal(Backend.isCacheValid({ result: null, ts: 1000 }, 1000), false);
});
