#!/usr/bin/env node
// Real ChatGPT UI, no prompt submission. Activation timing is controlled; geometry and clocks are not.
// Usage: node scripts/effort-readiness-live-proof.mjs <CDP-port> <baseline-thinkingTime.js> <output-dir> [candidate-thinkingTime.js]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import CDP from "chrome-remote-interface";

const port = Number(process.argv[2]);
assert.ok(
  Number.isInteger(port) && port > 0 && process.argv[3] && process.argv[4],
  "See usage in script header",
);
const output = path.resolve(process.argv[4]);
await mkdir(output, { recursive: true });
const paths = {
  baseline: path.resolve(process.argv[3]),
  candidate: process.argv[5]
    ? path.resolve(process.argv[5])
    : fileURLToPath(new URL("../dist/src/browser/actions/thinkingTime.js", import.meta.url)),
};
const builds = {};
for (const [name, file] of Object.entries(paths)) {
  builds[name] = {
    select: (await import(pathToFileURL(file).href)).ensureThinkingTime,
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(path.dirname(file), "../../../.."),
      encoding: "utf8",
    }).trim(),
    moduleSha256: createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  };
}
let c, cover, warm;
const clients = new Set();
const ownedTargets = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const r = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  assert.equal(r.exceptionDetails, undefined, r.exceptionDetails?.exception?.description);
  return r.result.value;
};
const readPicker = () =>
  evaluate(`(() => {
  const simple = [...document.querySelectorAll('[data-testid="composer-model-picker-slider-simple-view"]')].find(e => e.getAttribute('data-active') === 'true');
  const slider = simple?.querySelector('[data-model-reasoning-effort-slider]');
  const control = slider?.closest('[role="menuitem"]');
  const thumb = slider?.querySelector('[role="slider"]');
  if (!control || !thumb || control.closest('[role="menu"]')?.getAttribute('data-state') !== 'open') return null;
  const r = control.getBoundingClientRect();
  return { width:r.width, height:r.height, index:Number(thumb.getAttribute('aria-valuenow')), min:thumb.getAttribute('aria-valuemin'), max:thumb.getAttribute('aria-valuemax'), announcement:(control.getAttribute('aria-describedby')||'').split(/\\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').slice(0,180) };
})()`);
const readClosedTier = () =>
  evaluate(`(() => {
        const buttons=[...document.querySelectorAll('button')].filter(e=>e.closest('[class*="composer"]')||e.closest('form'));
        for(const e of buttons){const r=e.getBoundingClientRect();const label=(e.textContent||'').trim();if(r.width<=0||r.height<=0)continue;
          const index=label.endsWith('Pro')?4:label.includes('Extra High')?3:label==='High'?2:label==='Medium'?1:label==='Instant'?0:null;
          if(index!==null)return {label,index,rect:{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}};
        } return null;
      })()`);

const closePicker = async () => {
  await c.Input.dispatchKeyEvent({
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await c.Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await delay(150);
};
const openPicker = async () => {
  if ((await readPicker())?.height > 0) return;
  let point;
  for (let attempt = 0; attempt < 40 && !point; attempt++) {
    point = await evaluate(`(() => {
    const button=[...document.querySelectorAll('button[aria-haspopup="menu"]')].find(e => { const rect=e.getBoundingClientRect(); return rect.width>0 && rect.height>0 && /^(?:[0-9.]+\\s*)?(?:Pro|Extra High|Thinking effort|Medium|High|Instant)$/i.test((e.textContent||'').replace(/\\s+/g,' ').trim());});
    if(!button)return null; const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
    if (!point) await delay(150);
  }
  assert.ok(point, "No supported direct-slider trigger in this UI");
  await c.Input.dispatchMouseEvent({ type: "mouseMoved", ...point });
  await c.Input.dispatchMouseEvent({
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await c.Input.dispatchMouseEvent({
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
  for (let i = 0; i < 30; i++) {
    if ((await readPicker())?.height > 0) return;
    await delay(100);
  }
  const diagnostic = await evaluate(
    `JSON.stringify([...document.querySelectorAll('[role="menu"]')].map(e=>({html:e.outerHTML.slice(0,18000),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})))`,
  );
  await writeFile(path.join(output, "picker-failure.json"), diagnostic);
  throw new Error("Picker did not become visible");
};
const installProbe = () =>
  evaluate(`(() => {
  const state={started:performance.now(),events:[]};
  const key=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key))state.events.push({type:event.type,key:event.key,atMs:performance.now()-state.started,trusted:event.isTrusted});};
  document.addEventListener('keydown',key,true);document.addEventListener('keyup',key,true);
  window.__oracleReadinessProof=state;
  window.__restoreOracleReadinessProof=()=>{document.removeEventListener('keydown',key,true);document.removeEventListener('keyup',key,true);};
})()`);
// Observe the real resolver without changing its conditions, return value, DOM, geometry, or clock.
const tracedRuntime = (client) => ({
  ...client.Runtime,
  evaluate: (options) => {
    let expression = options.expression;
    const section = expression.indexOf("const selectDirectEffortSlider = async");
    if (section >= 0) {
      const begin = expression.indexOf("const resolve = () => {", section);
      const use = expression.indexOf("let current = resolve();", begin);
      assert.ok(
        begin >= 0 && use > begin,
        "Unknown selector layout; do not silently instrument another path",
      );
      const wrapper = `const resolve = () => {
      const value=observeOriginalResolve();
      const view=menu.querySelector('[data-model-selection-view="true"]');
      const simple=view?.querySelector('[data-testid="composer-model-picker-slider-simple-view"]');
      const slider=simple?.querySelector('[data-model-reasoning-effort-slider]');
      const control=slider?.closest('[role="menuitem"]');
      const thumb=slider?.querySelector('[role="slider"]');
      const rect=control?.getBoundingClientRect();
      const event={type:'resolver',atMs:performance.now()-window.__oracleReadinessProof.started,ready:Boolean(value),simpleActive:simple?.getAttribute('data-active')??null,controlPresent:Boolean(control),width:rect?.width??null,height:rect?.height??null,index:thumb?.getAttribute('aria-valuenow')??null,level:value?.level??null};
      window.__oracleReadinessProof.events.push(event);window.oracleReadinessProbe(JSON.stringify(event));
      return value;
    };`;
      expression =
        expression.slice(0, begin) +
        expression
          .slice(begin, use)
          .replace("const resolve = () => {", "const observeOriginalResolve = () => {") +
        wrapper +
        expression.slice(use);
    }
    return client.Runtime.evaluate({ ...options, expression });
  },
});
let initialIndex;
let activation;
let unreadySeen = false;
function listenForReadiness(client) {
  client.Runtime.bindingCalled(({ name, payload }) => {
    if (name !== "oracleReadinessProbe") return;
    const sample = JSON.parse(payload);
    if (sample.type !== "resolver" || sample.ready !== false || unreadySeen) return;
    unreadySeen = true;
    activation = delay(250).then(async () => {
      await evaluate(
        "window.__oracleReadinessProof.events.push({type:'foreground-requested',atMs:performance.now()-window.__oracleReadinessProof.started})",
      );
      await c.Page.bringToFront();
    });
  });
}
const report = {
  experiment:
    "real ChatGPT UI with controlled foreground timing after an observed unready resolver; diagnostic wrapper preserves original resolver conditions and return values, DOM, geometry, and clocks",
  builds: Object.fromEntries(
    Object.entries(builds).map(([k, v]) => [
      k,
      { revision: v.revision, moduleSha256: v.moduleSha256 },
    ]),
  ),
  attempts: [],
};
try {
  const target = await CDP.New({ host: "127.0.0.1", port, url: "about:blank" });
  ownedTargets.add(target.id);
  c = await CDP({ host: "127.0.0.1", port, target: target.id });
  warm = c;
  clients.add(c);
  const curtain = await CDP.New({ host: "127.0.0.1", port, url: "about:blank" });
  ownedTargets.add(curtain.id);
  cover = await CDP({ host: "127.0.0.1", port, target: curtain.id });
  clients.add(cover);
  listenForReadiness(c);
  await c.Page.enable();
  await c.Runtime.enable();
  await c.Runtime.addBinding({ name: "oracleReadinessProbe" });
  await c.Page.navigate({ url: "https://chatgpt.com/" });
  await c.Page.bringToFront();
  for (let i = 0; i < 60; i++) {
    if (await evaluate("Boolean(document.querySelector('#prompt-textarea'))")) break;
    await delay(250);
  }
  await openPicker();
  initialIndex = (await readPicker()).index;
  await closePicker();
  report.chrome = (await CDP.Version({ host: "127.0.0.1", port })).Browser;
  for (const name of ["baseline", "candidate"]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await c.Page.bringToFront();
      await builds.candidate.select(c.Runtime, "extra-high", () => {}, "Latest");
      await openPicker();
      assert.equal((await readPicker()).index, 3);
      await closePicker();
      await cover.Page.bringToFront();
      const fresh = await CDP.New({ host: "127.0.0.1", port, url: "about:blank" });
      ownedTargets.add(fresh.id);
      c = await CDP({ host: "127.0.0.1", port, target: fresh.id });
      clients.add(c);
      await c.Page.enable();
      await c.Runtime.enable();
      listenForReadiness(c);
      await c.Runtime.addBinding({ name: "oracleReadinessProbe" });
      await c.Page.navigate({ url: "https://chatgpt.com/" });
      for (let i = 0; i < 60; i++) {
        if (await evaluate("Boolean(document.querySelector('#prompt-textarea'))")) break;
        await delay(100);
      }

      unreadySeen = false;
      activation = undefined;
      await installProbe();
      let error;
      const logs = [];
      try {
        await builds[name].select(
          tracedRuntime(c),
          "pro",
          (line) => {
            if (line.startsWith("[browser] Thinking time:")) logs.push(line);
          },
          "Latest",
        );
      } catch (e) {
        error = e.message;
      }
      if (activation) await activation;
      const events = await evaluate(
        "window.__restoreOracleReadinessProof();window.__oracleReadinessProof.events",
      );
      await writeFile(
        path.join(output, `${name}-${attempt}-observed.json`),
        JSON.stringify({ name, attempt, events, logs, error }, null, 2),
      );
      await c.Page.bringToFront();
      await delay(400);
      await closePicker();
      const persisted = await readClosedTier();
      if (persisted?.rect) {
        const shot = await c.Page.captureScreenshot({ format: "png", clip: persisted.rect });
        await writeFile(
          path.join(output, `${name}-${attempt}-composer.png`),
          Buffer.from(shot.data, "base64"),
        );
      }
      const states = events.filter((e) => e.type === "resolver");
      const firstUnready = states[0]?.ready === false ? states[0] : null;
      const extraHigh = states.find((e) => e.ready && e.index === "3" && e.level === "extra-high");
      const pro = states.find((e) => e.ready && e.index === "4" && e.level === "pro");
      const keys = events.filter(
        (e) => e.type === "keydown" && ["ArrowLeft", "ArrowRight"].includes(e.key),
      );
      const qualifies =
        name === "baseline"
          ? Boolean(
              firstUnready &&
              /selection unverified/.test(error ?? "") &&
              keys.length === 0 &&
              persisted?.index === 3,
            )
          : Boolean(
              firstUnready &&
              extraHigh &&
              pro &&
              !error &&
              keys.length === 1 &&
              keys[0].key === "ArrowRight" &&
              extraHigh.atMs > firstUnready.atMs &&
              keys[0].atMs >= extraHigh.atMs &&
              pro.atMs > keys[0].atMs &&
              persisted?.index === 4,
            );
      const result = {
        build: name,
        attempt,
        controlledForegroundDelayMs: 250,
        events,
        logs,
        error,
        persisted,
        qualifies,
      };
      report.attempts.push(result);
      console.log(JSON.stringify(result));
      await c.close();
      clients.delete(c);
      await CDP.Close({ host: "127.0.0.1", port, id: fresh.id });
      ownedTargets.delete(fresh.id);
      c = warm;
      if (qualifies) break;
    }
  }
  report.passed = ["baseline", "candidate"].every((name) =>
    report.attempts.some((x) => x.build === name && x.qualifies),
  );
} catch (error) {
  report.error = error.message;
} finally {
  const failures = [];
  const attempt = async (name, action) => {
    try {
      await action();
    } catch (error) {
      failures.push({ step: name, error: error.message });
    }
  };
  await attempt("probe cleanup", async () => {
    if (c) await evaluate("window.__restoreOracleReadinessProof?.()");
  });
  c = warm;
  await attempt("original tier restore", async () => {
    if (!c || initialIndex === undefined) return;
    await c.Page.bringToFront();
    await builds.candidate.select(
      c.Runtime,
      ["light", "standard", "extended", "extra-high", "pro"][initialIndex],
      () => {},
      "Latest",
    );
    await delay(400);
    assert.equal((await readClosedTier())?.index, initialIndex, "Original tier was not restored");
  });
  await Promise.all([...clients].map((client) => attempt("client close", () => client.close())));
  await Promise.all(
    [...ownedTargets].map((id) =>
      attempt("owned tab close", () => CDP.Close({ host: "127.0.0.1", port, id })),
    ),
  );
  report.cleanup = { passed: failures.length === 0, failures };
}
report.passed = Boolean(report.passed && !report.error && report.cleanup.passed);
await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(report.passed ? "PROOF_OK" : "PROOF_INCOMPLETE");
if (!report.passed) process.exitCode = 1;
