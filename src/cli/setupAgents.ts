import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import inquirer from "inquirer";
import { getOracleHomeDir } from "../oracleHome.js";

type Agent = "codex" | "claude";
type Run = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;
const execFileAsync = promisify(execFile);
const run: Run = async (command, args) => {
  try {
    const result = await execFileAsync(command, args, { cwd: os.homedir(), timeout: 15_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(e.code ?? "execution failed"),
    };
  }
};

export function mcpRegistrationCommand(
  agent: Agent,
  node: string,
  entry: string,
  oracleHome = getOracleHomeDir(),
  browserProfile = process.env.ORACLE_BROWSER_PROFILE_DIR,
): string[] {
  const environment = ["ORACLE_ENGINE=browser", `ORACLE_HOME_DIR=${path.resolve(oracleHome)}`];
  if (browserProfile)
    environment.push(`ORACLE_BROWSER_PROFILE_DIR=${path.resolve(browserProfile)}`);
  const envArgs = environment.flatMap((value) => ["--env", value]);
  return agent === "codex"
    ? ["mcp", "add", "oracle", ...envArgs, "--", node, entry]
    : [
        "mcp",
        "add",
        "oracle",
        "--scope",
        "user",
        "--transport",
        "stdio",
        ...envArgs,
        "--",
        node,
        entry,
      ];
}

export async function inspectAgents(execute: Run = run, home = os.homedir(), env = process.env) {
  return Promise.all(
    (["codex", "claude"] as Agent[]).map(async (agent) => {
      const available = (await execute(agent, ["--version"])).code === 0;
      const configFile =
        agent === "codex"
          ? path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml")
          : path.join(home, ".claude.json");
      let configured = false;
      let problem: string | undefined;
      if (available && agent === "codex") {
        const result = await execute(agent, ["mcp", "get", "oracle", "--json"]);
        configured = result.code === 0;
        if (result.code !== 0 && !/No MCP server named/i.test(result.stderr))
          problem = "Could not inspect the existing Codex MCP entry.";
      }
      if (available && agent === "claude") {
        if (env.CLAUDE_CONFIG_DIR)
          problem =
            "Custom CLAUDE_CONFIG_DIR: use the previewed native command to select the intended configuration scope.";
        else {
          try {
            configured = Boolean(
              JSON.parse(await fs.readFile(configFile, "utf8")).mcpServers?.oracle,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              problem = "Could not parse the existing Claude Code user configuration.";
          }
        }
      }
      return { agent, available, configured, configFile, problem };
    }),
  );
}

export async function setupAgents(options: { agents?: string; dryRun?: boolean; json?: boolean }) {
  const detected = await inspectAgents();
  let selected: Agent[];
  if (options.agents) {
    const names = [
      ...new Set(
        options.agents
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
    if (!names.length || names.some((x) => x !== "codex" && x !== "claude"))
      throw new Error("--agents accepts codex,claude.");
    selected = names as Agent[];
  } else if (options.dryRun) {
    selected = detected.filter((x) => x.available).map((x) => x.agent);
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        "Use oracle setup --agents codex,claude or --dry-run in non-interactive environments.",
      );
    ({ selected } = await inquirer.prompt<{ selected: Agent[] }>([
      {
        type: "checkbox",
        name: "selected",
        message:
          "Which installed agents should receive Oracle MCP integration? Existing entries will be preserved.",
        choices: detected.map((x) => ({
          name: `${x.agent}${x.configured ? " (already configured)" : ""}${!x.available ? " (not installed)" : ""}`,
          value: x.agent,
          disabled: !x.available,
        })),
      },
    ]));
  }
  const entry = fileURLToPath(new URL("../../bin/oracle-mcp.js", import.meta.url));
  const plan = selected.map((agent) => {
    const info = detected.find((x) => x.agent === agent)!;
    return {
      ...info,
      command: agent,
      args: mcpRegistrationCommand(agent, process.execPath, entry),
      action: info.configured ? "preserve-existing" : "register",
    };
  });
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, detected, plan }, null, 2));
    return;
  }
  if (plan.some((x) => !x.available || x.problem))
    throw new Error(
      "A selected agent is unavailable or its configuration could not be inspected. Run oracle setup --dry-run; no registration was changed.",
    );
  await fs.access(entry);
  const results: Array<Record<string, unknown>> = [];
  for (const item of plan) {
    if (item.configured) {
      results.push({
        agent: item.agent,
        status: "preserved-existing",
        configFile: item.configFile,
      });
      continue;
    }
    const backup = path.join(
      getOracleHomeDir(),
      "backups",
      `agent-setup-${Date.now()}`,
      item.agent + path.extname(item.configFile),
    );
    let savedBackup: string | null = null;
    try {
      await fs.access(item.configFile);
      await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      await fs.copyFile(item.configFile, backup);
      await fs.chmod(backup, 0o600);
      savedBackup = backup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const result = await run(item.command, item.args);
    const verified =
      result.code === 0 &&
      (await inspectAgents()).find((x) => x.agent === item.agent)?.configured === true;
    results.push({
      agent: item.agent,
      status: verified ? "registered" : "failed",
      configFile: item.configFile,
      backup: savedBackup,
      exitCode: result.code,
    });
    if (!verified) {
      console.log(JSON.stringify({ results }, null, 2));
      throw new Error(
        `Native ${item.agent} MCP registration failed or could not be verified. The backup path is listed above; inspect the client before retrying.`,
      );
    }
  }
  console.log(
    JSON.stringify(
      {
        results,
        next: "Restart the selected agents. Use oracle configure to choose the browser model; updates preserve that choice.",
      },
      null,
      2,
    ),
  );
}
