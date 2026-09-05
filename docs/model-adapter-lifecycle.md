# Adapting Oracle as models evolve

This fork focuses on making model changes repeatable and verifiable. A specific model is an adapter with a tested contract; the project's value is the process that lets those adapters evolve while callers and stored tasks remain usable.

The current modern-GPT registry is `src/oracle/modelCapabilities.ts`. It centralizes canonical names and aliases, browser picker targets and version evidence, API reasoning capabilities, limits and pricing. Model choices and modern-model routing derive from it. Older upstream model families still have legacy mappings; migration of every provider into this registry is not claimed.

## Lifecycle

1. **Register the contract.** Establish the new model's actual identifiers, supported engine, reasoning controls, limits and browser selection signals. API reasoning parameters and browser effort levels remain separate.
2. **Verify the adapter.** Test aliases and invalid variants, selector transitions, unavailable controls, and model/version mismatches. For supported text browser runs, bind the returned answer to its conversation ID, message ID and reported model slug. Missing evidence is explicitly unverified; mismatches do not trigger automatic resubmission.
3. **Preserve user choices.** Ship the adapter in an update and expose it through `oracle configure`. Keep the saved default until the user chooses otherwise. Existing client registrations continue pointing at the shared Oracle installation.
4. **Retain recovery.** Keep the prior runtime/configuration for rollback. Continue a task using its recorded session reference; recovering an interrupted response is distinct from submitting a new question.

`Latest` is a moving UI alias, not a version identity. An adapter must verify the requested generation instead of assuming that the word will always mean the same model. Unknown future variants fail until support is established; no automatic compatibility with unreleased models is promised.

## Current scope

- Deployment and update: CLI model chooser, optional Codex/Claude Code detection and registration, JSON previews, configuration backups, existing session/status commands.
- Shared installation: client-specific MCP registrations reference one runtime; whole client configuration directories are not shared.
- Evidence: ordinary GPT-6 browser text requests have message-bound model checks. Browser evidence reports what the ChatGPT client exposes, not independent attestation of backend model weights.
- Remaining work: reconcile model/effort evidence with upstream PRs, broaden tested adapters/providers, and assess whether a visual deployment panel adds value. Runtime hot-loading of model definitions and cross-client locking of a single historical conversation are not implemented.

For installation and practical commands, see the [maintained build guide](gpt6-local.md). Generic fixes are contributed as small upstream PRs so the maintenance fork can stay close to Oracle.
