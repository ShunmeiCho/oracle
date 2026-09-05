import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { inspectAgents, mcpRegistrationCommand } from "../../src/cli/setupAgents.js";

describe("agent setup", () => {
  it("points both clients to the same runtime using argument arrays", () => {
    const node = "/opt/node bin/node";
    const entry = "/opt/oracle releases/current/oracle-mcp.js";
    for (const agent of ["codex", "claude"] as const) {
      const args = mcpRegistrationCommand(agent, node, entry);
      expect(args.slice(-3)).toEqual(["--", node, entry]);
      expect(args).toContain("ORACLE_ENGINE=browser");
    }
    expect(mcpRegistrationCommand("claude", node, entry)).toContain("user");
  });

  it("keeps custom model and browser configuration in both client registrations", () => {
    for (const agent of ["codex", "claude"] as const) {
      const args = mcpRegistrationCommand(
        agent,
        "/node",
        "/oracle-mcp.js",
        "/custom oracle",
        "/custom chrome",
      );
      expect(args).toContain("ORACLE_HOME_DIR=/custom oracle");
      expect(args).toContain("ORACLE_BROWSER_PROFILE_DIR=/custom chrome");
      expect(args.filter((x) => x === "--env")).toHaveLength(3);
    }
  });

  it("detects existing client configuration without overwriting or health-checking it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oracle-agents-"));
    try {
      await writeFile(
        path.join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { oracle: { command: "existing" } }, preserved: true }),
      );
      const calls: string[][] = [];
      const result = await inspectAgents(
        async (command, args) => {
          calls.push([command, ...args]);
          return { code: 0, stdout: "{}", stderr: "" };
        },
        home,
        {},
      );
      expect(result.every((x) => x.available && x.configured)).toBe(true);
      expect(calls).not.toContainEqual(["claude", "mcp", "get", "oracle"]);
      expect(calls.some((x) => x.includes("add"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps inspection failures distinct from a missing integration", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oracle-agents-"));
    try {
      await mkdir(path.join(home, ".codex"));
      const result = await inspectAgents(
        async (_command, args) =>
          args[0] === "--version"
            ? { code: 0, stdout: "version", stderr: "" }
            : { code: 1, stdout: "", stderr: "Invalid config" },
        home,
        {},
      );
      expect(result.find((x) => x.agent === "codex")?.problem).toBeTruthy();
      expect(result.find((x) => x.agent === "claude")?.configured).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
