import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSON5 from "json5";
import inquirer from "inquirer";
import { configPath } from "../config.js";
import { GPT_MODEL_CAPABILITIES, resolveGptModelAlias } from "../oracle/modelCapabilities.js";
import { resolveDefaultBrowserThinkingTime } from "./browserConfig.js";
import { normalizeThinkingTimeLevel } from "../oracle/thinkingTime.js";

export function browserModelChoices(): Array<{ name: string; value: string }> {
  return [
    ...Object.entries(GPT_MODEL_CAPABILITIES).flatMap(([model, spec]) => [
      { name: `${model} + Pro (${spec.browser.label})`, value: spec.browser.proAlias },
      { name: `${model} (${spec.browser.label})`, value: model },
    ]),
    { name: "GPT-5.6 Sol", value: "gpt-5.6-sol" },
    { name: "GPT-5.5 Pro", value: "gpt-5.5-pro" },
    { name: "GPT-5.5 Thinking", value: "gpt-5.5" },
  ];
}

async function readRawConfig(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function parseConfig(raw: string): Record<string, unknown> {
  const parsed: unknown = raw.trim() ? JSON5.parse(raw) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Oracle config must be an object.");
  return parsed as Record<string, unknown>;
}

export async function saveBrowserModel(
  model: string,
  thinkingTime?: string,
  file = configPath(),
  dryRun = false,
) {
  // Persist only declared choices or aliases, never the legacy CLI's fuzzy fallback.
  const registered = resolveGptModelAlias(model);
  const normalized = registered
    ? registered.pro
      ? GPT_MODEL_CAPABILITIES[registered.model].browser.proAlias
      : registered.model
    : model.trim().toLowerCase().replace(/[ _]+/g, "-");
  if (!browserModelChoices().some((x) => x.value === normalized)) {
    throw new Error(
      `Unsupported browser model "${model}". Run oracle configure --list; update the adapter before selecting a new model.`,
    );
  }
  const level = thinkingTime
    ? normalizeThinkingTimeLevel(thinkingTime)
    : resolveDefaultBrowserThinkingTime({
        model: normalized,
        requestedModel: model,
        modelStrategy: "select",
      });
  if (thinkingTime && !level) throw new Error(`Unsupported thinking time: ${thinkingTime}`);
  const raw = await readRawConfig(file);
  const config = parseConfig(raw);
  if (
    config.browser !== undefined &&
    (!config.browser || typeof config.browser !== "object" || Array.isArray(config.browser))
  ) {
    throw new Error("Oracle browser config must be an object.");
  }
  const browser: Record<string, unknown> = {
    ...(config.browser as Record<string, unknown>),
    modelStrategy: "select",
  };
  if (level) browser.thinkingTime = level;
  else delete browser.thinkingTime;
  if (!browser.remoteChrome && !browser.remoteHost && browser.manualLogin === undefined)
    browser.manualLogin = true;
  const updated = { ...config, engine: "browser", model: normalized, browser };
  if (dryRun)
    return {
      path: file,
      model: normalized,
      thinkingTime: level ?? null,
      backup: null,
      changed: false,
      dryRun: true,
    };
  if (JSON.stringify(updated) === JSON.stringify(config))
    return {
      path: file,
      model: normalized,
      thinkingTime: level ?? null,
      backup: null,
      changed: false,
    };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const backup = raw ? `${file}.bak-${suffix}` : null;
  if (backup) {
    await fs.copyFile(file, backup, constants.COPYFILE_EXCL);
    await fs.chmod(backup, 0o600);
  }
  if ((await readRawConfig(file)) !== raw)
    throw new Error("Oracle config changed during selection; rerun configure.");
  const temp = `${file}.tmp-${suffix}`;
  try {
    await fs.writeFile(temp, JSON.stringify(updated, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
  return { path: file, model: normalized, thinkingTime: level ?? null, backup, changed: true };
}

export async function configureBrowser(options: {
  list?: boolean;
  show?: boolean;
  model?: string;
  thinkingTime?: string;
  json?: boolean;
  dryRun?: boolean;
}) {
  const choices = browserModelChoices();
  if (options.list) {
    console.log(
      options.json
        ? JSON.stringify(choices, null, 2)
        : "Supported by this adapter; account availability is checked at runtime:\n" +
            choices.map((x) => `${x.value}\t${x.name}`).join("\n"),
    );
    return;
  }
  const current = parseConfig(await readRawConfig(configPath()));
  if (options.show) {
    const browser = current.browser as Record<string, unknown> | undefined;
    console.log(
      JSON.stringify(
        {
          path: configPath(),
          engine: current.engine,
          model: current.model,
          thinkingTime: browser?.thinkingTime ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  let model = options.model;
  if (!model) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error("Use oracle configure --model <id> in non-interactive environments.");
    ({ model } = await inquirer.prompt<{ model: string }>([
      {
        type: "list",
        name: "model",
        message: "Choose the default ChatGPT browser model",
        choices,
        default: choices.some((x) => x.value === current.model) ? current.model : choices[0]?.value,
      },
    ]));
  }
  const result = await saveBrowserModel(
    model!,
    options.thinkingTime,
    configPath(),
    Boolean(options.dryRun),
  );
  console.log(
    options.json
      ? JSON.stringify(result, null, 2)
      : `${options.dryRun ? "Preview" : "Saved browser model"}: ${result.model}; thinking: ${result.thinkingTime ?? "model default"}\nConfig: ${result.path}${result.backup ? `\nBackup: ${result.backup}` : ""}`,
  );
}
