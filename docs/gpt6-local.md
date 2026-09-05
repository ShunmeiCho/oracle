# Local GPT-6 support

This local build is based on upstream PR #448 at `414a0e34816037e1c73686c6e61b00caa23fd5ed`, with additional verification fixes and selected API validation/tests from PR #449 at `0ecfc00a51ca32c2adbb98f850f1b3b946873511`. It is not a published upstream release.

For ChatGPT browser use:

```sh
oracle --engine browser --model gpt-6-pro --remote-chrome 127.0.0.1:9222 -p "Your question"
```

`gpt-6-astra` selects the current Latest model without requesting Pro. `gpt-6-pro` selects Latest plus the Pro effort tier. The selection must expose a GPT-6 version signal such as `6 Pro`; a checked Latest radio alone is insufficient. This prevents the moving Latest alias from silently becoming another model generation. Model and Pro-effort evidence are verified separately.

MCP callers can use `engine: "browser", model: "gpt-6-pro"`, or `preset: "chatgpt-gpt6-pro"`. The old `chatgpt-pro-heavy` preset and GPT-5 aliases retain their historical behavior.

`current` mode records what is observed and leaves `verified: false`; use the default `select` mode when a specific model is required. Do not treat `current` or `ignore` as proof of an Astra selection.

For the separately authenticated API path, use `gpt-6-astra`, optionally with `--reasoning-mode pro`. Supported API efforts are low, medium, high, xhigh and max. Browser `gpt-6-pro` and Codex `ultra` are not API model/effort values. API validation is covered with mocked clients; browser testing does not establish API account access.

Keep the previous installed package and machine configuration before deploying this build. A future official upgrade must be checked for the same alias and verification behavior before replacing it. Restart existing MCP clients after changing the installed runtime so they load the new code.

## Install once, connect clients

Build with Node 24+ and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test --exclude 'tests/live/**'
npm pack --ignore-scripts
npm install -g ./steipete-oracle-0.18.0-gpt6.local.1.tgz --ignore-scripts
oracle configure
oracle setup
```

The interactive model chooser lists targets supported by this adapter. It does not claim that every target is available to the signed-in account. `configure` preserves connection and session settings, backs up an existing configuration, and writes the new default atomically. `setup` detects Codex and Claude Code, lets the operator select clients, preserves existing Oracle registrations, and uses each client's native MCP registration command. Neither command installs an agent or changes its primary model.

For automation, choose the scope explicitly:

```sh
oracle configure --list --json
oracle configure --model gpt-6-pro --dry-run --json
oracle configure --model gpt-6-pro
oracle setup --dry-run --json
oracle setup --agents codex,claude
```

Both registrations point to the same absolute Node executable and Oracle MCP entrypoint, carrying the resolved Oracle configuration directory and any explicitly configured browser profile directory. The clients start separate stdio processes from that shared installation. Oracle's existing browser tab leases coordinate concurrent requests. A Codex-only installation can use `--agents codex`; an existing integration is left intact and should be checked for the intended runtime path.

Do not symlink entire Codex and Claude configuration directories: their formats, scope, and permissions differ. A stable version symlink for the Oracle runtime is optional; client-specific MCP configuration remains separate. Skills can share portable usage guidance, while client-specific guidance stays in the respective client environment.

## Update, model selection, and rollback

An update keeps the saved model until the operator runs `oracle configure` again. The model registry in `src/oracle/modelCapabilities.ts` centralizes supported modern GPT identities, aliases, browser version evidence and API capabilities. A new generation needs a verified adapter entry and tests; an unknown future label is rejected instead of silently selecting an older model. A moving `Latest` label is checked against the requested generation on every selection.

Before an update, retain the previous package/runtime and configuration. Build and test the candidate, install it at the shared runtime location, run `oracle configure` if changing models, then restart MCP clients. Check `oracle --version`, `oracle configure --show`, a browser dry run, and one no-file browser request with both version and effort evidence. `oracle status` and `oracle session <id> --render` expose task status and recover saved results without submitting again.

If validation fails, restore the retained runtime and its matching Oracle configuration, then restart clients. Keep any newer session data. Restoring client configurations is necessary only if those registrations changed. The ordinary npm tarball resolves dependencies during installation; for an exact offline deployment, build a production directory with the pinned lockfile and preserve that complete directory, including its internal dependencies. Platform-specific binaries must match the target host.

This first version supplies a CLI chooser, client detection, JSON previews and existing status/session commands. It does not include a web console, automatic model discovery, unattended upgrades, or a hosted service.
