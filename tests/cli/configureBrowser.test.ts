import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserModelChoices, saveBrowserModel } from "../../src/cli/configureBrowser.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function configFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-model-config-"));
  dirs.push(dir);
  return path.join(dir, "config.json");
}

describe("browser model configuration", () => {
  it("previews a valid choice without writing configuration or backups", async () => {
    const file = await configFile();
    const before = '{"model":"gpt-5.6-sol"}';
    await writeFile(file, before);
    expect(await saveBrowserModel("gpt-6-pro", undefined, file, true)).toMatchObject({
      dryRun: true,
      changed: false,
      backup: null,
      model: "gpt-6-pro",
    });
    expect(await readFile(file, "utf8")).toBe(before);
  });
  it("preserves connection/session settings and makes a reversible model change", async () => {
    const file = await configFile();
    const old =
      '{model:"gpt-5-pro", browser:{remoteChrome:{host:"127.0.0.1",port:9222},archiveConversations:"never",thinkingTime:"heavy"},notify:{sound:false}}';
    await writeFile(file, old);
    const result = await saveBrowserModel("gpt-6-pro", undefined, file);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.model).toBe("gpt-6-pro");
    expect(saved.browser).toEqual({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      archiveConversations: "never",
      thinkingTime: "pro",
      modelStrategy: "select",
    });
    expect(saved.notify).toEqual({ sound: false });
    expect(await readFile(result.backup!, "utf8")).toBe(old);
    expect((await stat(result.backup!)).mode & 0o777).toBe(0o600);
    expect((await saveBrowserModel("gpt-6-pro", undefined, file)).changed).toBe(false);
  });

  it("changes to another supported generation without retaining an obsolete effort override", async () => {
    const file = await configFile();
    await saveBrowserModel("gpt-6-pro", undefined, file);
    await saveBrowserModel("gpt-5.6-sol", undefined, file);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.model).toBe("gpt-5.6-sol");
    expect(saved.browser.thinkingTime).toBeUndefined();
    expect(saved.browser.manualLogin).toBe(true);
  });

  it("does not replace an invalid config or guess an unsupported future model", async () => {
    const file = await configFile();
    await writeFile(file, "invalid json");
    await expect(saveBrowserModel("gpt-6-pro", undefined, file)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("invalid json");
    await expect(saveBrowserModel("gpt-99-pro", undefined, file)).rejects.toThrow(/Unsupported/);
    expect(browserModelChoices().some((x) => x.value === "gpt-99-pro")).toBe(false);
  });

  it.each(["chatgpt-7-pro", "not-a-model-pro", "gpt-99-pro"])(
    "rejects undeclared input %s without changing the selected default",
    async (model) => {
      const file = await configFile();
      await saveBrowserModel("gpt-6-pro", undefined, file);
      const before = await readFile(file, "utf8");
      await expect(saveBrowserModel(model, undefined, file)).rejects.toThrow(/Unsupported/);
      expect(await readFile(file, "utf8")).toBe(before);
    },
  );
});
