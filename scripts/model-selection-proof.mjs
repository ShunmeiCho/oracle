import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { ensureModelSelection } from "../dist/src/browser/actions/modelSelection.js";
import CDP from "chrome-remote-interface";
const port = Number(process.argv[2]);
assert.ok(
  Number.isInteger(port) && port > 0 && port <= 65535,
  "Usage: node scripts/model-selection-proof.mjs <CDP-port> [output.json]",
);
const target = await CDP.New({ host: "127.0.0.1", port, url: "about:blank" });
const c = await CDP({ host: "127.0.0.1", port, target: target.id });
const cases = [
  {
    name: "generic-trigger-summary",
    pill: "Thinking effort",
    summary: "6 Pro",
    checked: true,
    startOpen: true,
    expected: true,
  },
  {
    name: "generic-trigger-switch",
    pill: "Thinking effort",
    summary: "5.6 Pro",
    canSwitch: true,
    expected: true,
  },
  { name: "already-gpt6", pill: "6 Pro", expected: true },
  { name: "switch-from-56", pill: "5.6 Pro", canSwitch: true, expected: true },
  { name: "stale-pill-after-radio", pill: "5.6 Pro", checked: true, expected: false },
  { name: "opener-is-not-selection", pill: "5.6 Pro", noLatestRow: true, expected: false },
  { name: "hidden-old-radio", pill: "6 Pro", startOpen: true, hiddenOld: true, expected: true },
  {
    name: "effort-radio-is-not-model",
    pill: "6 Pro",
    startOpen: true,
    effortRadio: true,
    expected: true,
  },
  { name: "future-latest-is-not-astra", pill: "7 Pro", checked: true, expected: false },
  ...[
    ["7 Pro", "6 Pro"],
    ["6 Pro", "7 Pro"],
    ["5.6 Pro", "6 Pro"],
  ].map(([pill, summary]) => ({
    name: `conflicting-versions-${pill}-${summary}`,
    pill,
    summary,
    checked: true,
    startOpen: true,
    expected: false,
  })),
  { name: "portal-model-menu", pill: "5.6 Pro", portal: true, canSwitch: true, expected: true },
];
const results = [];
try {
  await c.Page.enable();
  await c.Runtime.enable();
  for (const test of cases) {
    await c.Page.navigate({ url: "about:blank" });
    const { frameTree } = await c.Page.getFrameTree();
    const radio = test.noLatestRow
      ? ""
      : `<button id="latest" role="menuitemradio" aria-checked="${Boolean(test.checked)}">Latest</button>`;
    const html = `<html><body>
      <button id="model" data-testid="model-switcher-dropdown-button" aria-haspopup="menu">${test.pill}</button>
      <div id="menu" role="menu" data-testid="composer-intelligence-picker-content" ${test.startOpen ? "" : "hidden"}>
        ${test.summary ? `<div id="summary" role="menuitem" aria-expanded="false" aria-label="Select model">${test.summary}</div>` : ""}
        <div data-testid="composer-model-picker-slider-advanced-view">
          <div id="opener" role="menuitem" aria-haspopup="menu" aria-controls="portal">Model Latest GPT-5.6 Sol</div>
          ${test.portal ? "" : radio}
          <button id="old" role="menuitemradio" aria-checked="${Boolean(test.hiddenOld)}" style="${test.hiddenOld ? "display:none" : ""}">GPT-5.6 Sol</button>
          ${test.effortRadio ? '<button role="menuitemradio" aria-checked="true">Pro</button>' : ""}
        </div>
      </div>
      <div id="portal" role="menu" hidden>${test.portal ? radio : ""}</div>
      <script>
        const state = ${JSON.stringify(test)};
        const model = document.getElementById('model');
        const menu = document.getElementById('menu');
        model.onclick = () => { menu.hidden = !menu.hidden; };
        document.getElementById('opener').onclick = () => { document.getElementById('portal').hidden = false; };
        window.latestClicks = 0;
        const latest = document.getElementById('latest');
        if (latest) latest.onclick = () => {
          window.latestClicks++;
          if (state.canSwitch) { if (state.summary) document.getElementById('summary').textContent = '6 Pro'; else model.textContent = '6 Pro'; latest.setAttribute('aria-checked','true'); document.getElementById('old').setAttribute('aria-checked','false'); }
        };
        let clock = 0;
        Object.defineProperty(performance, 'now', { value: () => (clock += 5000) });
      </script></body></html>`;
    await c.Page.setDocumentContent({ frameId: frameTree.frame.id, html });
    let evidence, error;
    try {
      evidence = await ensureModelSelection(c.Runtime, "Latest", () => {}, "select", {
        buttonWaitMs: 0,
        expectedModel: "gpt-6-astra",
      });
    } catch (e) {
      error = e.message;
    }
    if (test.expected) {
      assert.equal(evidence?.verified, true, `${test.name}: ${error}`);
      assert.equal(evidence?.resolvedLabel, "6 Pro");
      if (test.canSwitch) {
        const clicked = await c.Runtime.evaluate({
          expression: "window.latestClicks",
          returnByValue: true,
        });
        assert.ok(clicked.result.value > 0, "must actually select the requested model");
      }
    } else {
      assert.ok(error, `${test.name}: accepted ${JSON.stringify(evidence)}`);
    }
    results.push({ name: test.name, passed: true, evidence, error });
    console.log("PASS", test.name);
  }
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(results, null, 2));
} finally {
  await c.close();
  await CDP.Close({ host: "127.0.0.1", port, id: target.id });
}
