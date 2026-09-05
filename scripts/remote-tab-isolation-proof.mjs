#!/usr/bin/env node
// Real Chrome + real HTTP/WebSocket transport. Only the proxy's failure responses are injected.
// Usage: node scripts/remote-tab-isolation-proof.mjs [built-chromeLifecycle.js] [report.json]
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Launcher } from "chrome-launcher";
import CDP from "chrome-remote-interface";

const modulePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL("../dist/src/browser/chromeLifecycle.js", import.meta.url));
const { connectToRemoteChrome } = await import(pathToFileURL(modulePath).href);
let root;
const chromePath = [process.env.CHROME_PATH, ...Launcher.getInstallations()].find(
  (candidate) => candidate && existsSync(candidate),
);
assert.ok(chromePath, "Set CHROME_PATH to Chrome/Chromium");
let chrome;
const sockets = new Set();
const controls = [];
async function bounded(operation, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out during ${label}`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const sentinelIds = new Set();
let mode = "success";
let counters;
let proxyPort;
const resetCounters = () => ({ newAttempts: 0, created: [], closed: [], websocketTargets: [] });
const rewriteTarget = (target) => {
  if (!target.webSocketDebuggerUrl) return target;
  const url = new URL(target.webSocketDebuggerUrl);
  url.host = `127.0.0.1:${proxyPort}`;
  return { ...target, webSocketDebuggerUrl: url.href };
};
const proxy = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/json/new") {
      counters.newAttempts++;
      if (mode === "create-failure") {
        response.writeHead(500);
        response.end("Injected creation failure");
        return;
      }
    }
    const upstream = await fetch(`http://127.0.0.1:${chrome.port}${request.url}`, {
      method: request.method,
      signal: AbortSignal.timeout(5000),
    });
    const raw = await upstream.text();
    if (pathname.startsWith("/json/close/")) counters.closed.push(pathname.split("/").at(-1));
    let body = raw;
    try {
      let data = JSON.parse(raw);
      if (pathname === "/json/new" && data.id) counters.created.push(data.id);
      if (Array.isArray(data)) {
        // Deterministically expose our protected fixture as the default page.
        data.sort((a, b) => Number(sentinelIds.has(b.id)) - Number(sentinelIds.has(a.id)));
        data = data.map(rewriteTarget);
      } else data = rewriteTarget(data);
      body = JSON.stringify(data);
    } catch {
      /* Chrome close responses are plain text. */
    }
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "text/plain",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(502);
    response.end(String(error.message));
  }
});
proxy.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
proxy.on("upgrade", (request, socket, head) => {
  const targetId = request.url.split("/").at(-1);
  counters.websocketTargets.push(targetId);
  if (mode === "attach-failure" && counters.created.includes(targetId)) {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const upstream = net.connect(chrome.port, "127.0.0.1", () => {
    const headers = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      if (request.rawHeaders[i].toLowerCase() !== "host")
        headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    }
    upstream.write(
      `${request.method} ${request.url} HTTP/1.1\r\nHost: 127.0.0.1:${chrome.port}\r\n${headers.join("\r\n")}\r\n\r\n`,
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  sockets.add(upstream);
  upstream.on("close", () => sockets.delete(upstream));
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
const snapshot = async (client) => {
  const { result } = await bounded(
    client.Runtime.evaluate({
      expression:
        "({url:location.href,title:document.title,nonce:window.oracleSentinel,html:document.documentElement.outerHTML})",
      returnByValue: true,
    }),
    "sentinel snapshot",
  );
  const { html, ...state } = result.value;
  return { ...state, htmlSha256: createHash("sha256").update(html).digest("hex") };
};
const report = {
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(path.dirname(modulePath), "../../.."),
    encoding: "utf8",
  }).trim(),
  moduleSha256: createHash("sha256")
    .update(await readFile(modulePath))
    .digest("hex"),
  platform: `${process.platform}/${process.arch}`,
  cases: [],
};
try {
  root = await mkdtemp(path.join(os.tmpdir(), "oracle-isolation-proof-"));
  chrome = new Launcher({
    chromePath,
    chromeFlags: [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
    userDataDir: root,
    handleSIGINT: false,
  });
  await chrome.launch();
  console.error("Temporary Chrome launched");
  assert.notEqual(chrome.port, 9222, "Proof must not use the persistent browser port");
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyPort = proxy.address().port;
  const version = await CDP.Version({ host: "127.0.0.1", port: chrome.port });
  report.chrome = version.Browser;
  for (const setup of ["fresh-profile", "reused-browser-with-existing-pages"]) {
    const target = await CDP.New({ host: "127.0.0.1", port: chrome.port, url: "about:blank" });
    sentinelIds.add(target.id);
    const client = await bounded(
      CDP({ host: "127.0.0.1", port: chrome.port, target: target.id }),
      "control connection",
    );
    const control = { client, navigations: 0 };
    controls.push(control);
    await bounded(client.Page.enable(), "sentinel Page.enable");
    await bounded(
      client.Runtime.evaluate({
        expression: `document.title='oracle-protected'; document.body.textContent='Unrelated task'; window.oracleSentinel=${JSON.stringify(randomUUID())};`,
      }),
      "sentinel setup",
    );
    client.Page.frameNavigated(() => {
      control.navigations++;
    });
    for (const scenario of ["create-failure", "attach-failure", "success"]) {
      mode = scenario;
      counters = resetCounters();
      const before = await Promise.all(controls.map((x) => snapshot(x.client)));
      const navigationBaseline = controls.map((x) => x.navigations);
      const targetsBefore = (await CDP.List({ host: "127.0.0.1", port: chrome.port }))
        .map((x) => x.id)
        .sort();
      let connection, failure;
      try {
        connection = await bounded(
          connectToRemoteChrome("127.0.0.1", proxyPort, () => {}, "about:blank", undefined, {
            fallbackToDefault: false,
          }),
          "candidate connection",
        );
        if (scenario === "success") {
          assert.ok(connection.targetId && !sentinelIds.has(connection.targetId));
          assert.ok(counters.created.includes(connection.targetId));
          const written = await bounded(
            connection.client.Runtime.evaluate({
              expression: "document.title='oracle-owned-new-task'; document.title",
              returnByValue: true,
            }),
            "owned target evaluation",
          );
          assert.equal(written.exceptionDetails, undefined);
          assert.equal(written.result.value, "oracle-owned-new-task");
        }
      } catch (error) {
        failure = error.message;
      } finally {
        if (connection) await connection.close();
      }
      const after = await Promise.all(controls.map((x) => snapshot(x.client)));
      const targetsAfter = (await CDP.List({ host: "127.0.0.1", port: chrome.port }))
        .map((x) => x.id)
        .sort();
      const evidence = {
        setup,
        scenario,
        protectedPageCount: controls.length,
        outcome: failure ? "rejected" : "connected",
        newAttempts: counters.newAttempts,
        createdTargets: counters.created.length,
        closedTargets: counters.closed.length,
        sentinelWebSocketAttempts: counters.websocketTargets.filter((id) => sentinelIds.has(id))
          .length,
        otherWebSocketAttempts: counters.websocketTargets.filter((id) => !sentinelIds.has(id))
          .length,
        sentinelNavigations: controls.reduce(
          (sum, x, i) => sum + x.navigations - navigationBaseline[i],
          0,
        ),
        sentinelUnchanged: JSON.stringify(before) === JSON.stringify(after),
        targetsRestored: JSON.stringify(targetsBefore) === JSON.stringify(targetsAfter),
        onlyOwnedTargetsClosed: counters.closed.every((id) => counters.created.includes(id)),
        before,
        after,
      };
      try {
        assert.ok(evidence.newAttempts > 0);
        if (scenario === "create-failure") {
          assert.equal(evidence.createdTargets, 0);
          assert.equal(evidence.closedTargets, 0);
          assert.equal(evidence.otherWebSocketAttempts, 0);
        } else {
          assert.ok(evidence.createdTargets > 0 && evidence.otherWebSocketAttempts > 0);
          assert.equal(evidence.closedTargets, evidence.createdTargets);
        }
        assert.ok(counters.websocketTargets.every((id) => counters.created.includes(id)));
        assert.equal(evidence.outcome, scenario === "success" ? "connected" : "rejected");
        if (scenario !== "success") assert.match(failure, /refusing to reuse/);
        assert.equal(evidence.sentinelWebSocketAttempts, 0);
        assert.equal(evidence.sentinelNavigations, 0);
        assert.ok(
          evidence.sentinelUnchanged && evidence.targetsRestored && evidence.onlyOwnedTargetsClosed,
        );
        evidence.passed = true;
      } catch (error) {
        evidence.passed = false;
        evidence.assertion = error.message;
      }
      report.cases.push(evidence);
      console.log(JSON.stringify({ ...evidence, before: undefined, after: undefined }));
    }
  }
  report.passed = report.cases.every((x) => x.passed);
} catch (error) {
  report.error = error.message;
} finally {
  const cleanupErrors = [];
  const cleanup = async (operation, label) => {
    try {
      await bounded(operation(), label);
    } catch (error) {
      cleanupErrors.push(`${label}: ${error.message}`);
    }
  };
  await Promise.all(controls.map(({ client }) => cleanup(() => client.close(), "control cleanup")));
  for (const socket of sockets) socket.destroy();
  if (proxy.listening)
    await cleanup(() => new Promise((resolve) => proxy.close(resolve)), "proxy cleanup");
  if (chrome) await cleanup(() => chrome.kill(), "Chrome cleanup");
  if (root) await cleanup(() => rm(root, { recursive: true, force: true }), "profile cleanup");
  report.cleanup = { passed: cleanupErrors.length === 0, errors: cleanupErrors };
}
report.passed = Boolean(report.passed && !report.error && report.cleanup.passed);
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + "\n");
console.log(report.passed ? "PROOF_OK" : "PROOF_FAILED");
if (!report.passed) process.exitCode = 1;
