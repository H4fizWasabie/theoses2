# Command hooks

Hooks run a shell command of yours at fixed points of an agent run. Use them to block or rewrite a tool call, format files after an edit, add context to a prompt, refuse to let a run end until something is true, or notify yourself. They need no TypeScript; for anything richer, write an [extension](extensions.md).

## Configuration

Under `hooks` in `settings.json`, keyed by event. The user settings (`~/.theoses/agent/settings.json`) always apply. A project's `.theoses/settings.json` applies only when the project is [trusted](#project-hooks).

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "^bash$", "command": "/home/me/hooks/no-rm.sh", "timeout": 10, "failClosed": true }
    ],
    "PostToolUse": [{ "matcher": "^(edit|write)$", "command": "/home/me/hooks/format.sh" }],
    "Stop": [{ "command": "/home/me/hooks/tests-must-pass.sh" }]
  }
}
```

| Field | Meaning |
|---|---|
| `command` | Required. Run through the shell, in the session's working directory, with the agent's environment. |
| `matcher` | Regex on the tool name, for `PreToolUse` and `PostToolUse`. Omitted matches every tool. |
| `timeout` | Seconds, default 30, at most 600. The command is killed when it runs out. |
| `failClosed` | If the hook itself errors, block instead of continuing (`PreToolUse`, `UserPromptSubmit`, `Stop`). Default false. |

A bad entry (missing `command`, invalid regex, unknown event) is reported once on stderr and skipped; the others still load. Hooks for one event run in the order listed, user hooks before project hooks.

## Events

| Event | Runs | A hook can |
|---|---|---|
| `PreToolUse` | before a tool call | block it; replace its input |
| `PostToolUse` | after a tool call | add context to the result the model reads |
| `UserPromptSubmit` | when a person submits a prompt (not one an extension sends) | add context after it; swallow it |
| `Stop` | when the model finishes and the run would end | hold the run open so the model keeps working |
| `SessionStart` | when a session starts, reloads, resumes or forks | react (output ignored) |
| `SessionEnd` | when a session ends, reloads or is replaced | react (output ignored) |

Calls made by internal sub-agents (`explore`, `research`) are not hooked.

## What a hook receives and returns

The command gets one JSON object on **stdin**, never in its arguments, so text the model wrote cannot inject shell.

Every event: `event`, `sessionId`, `cwd`. Then per event:

- `PreToolUse`: `toolName`, `toolCallId`, `toolInput`
- `PostToolUse`: those plus `toolResult` (text, cut at 20,000 characters) and `isError`
- `UserPromptSubmit`: `prompt`
- `Stop`: `stopHookActive` (true when a Stop hook is already holding this run open) and `lastAssistantText`
- `SessionStart` / `SessionEnd`: `reason`

To answer:

- **Exit 0** continues. If stdout is a JSON object it can carry a decision.
- **Exit 2** blocks, with stderr as the reason. For `PostToolUse` there is nothing left to block, so stderr goes to the model as context.
- **Any other exit, a timeout, or more than 64 KB of output** is a hook error: it is logged and the action continues, unless the hook sets `failClosed`.

JSON decisions on stdout:

| Event | Keys |
|---|---|
| `PreToolUse` | `{"decision":"block","reason":"..."}`, `{"updatedInput":{...}}` (replaces the whole input) |
| `PostToolUse` | `{"additionalContext":"..."}` (appended to the result as `[Hook] ...`) |
| `UserPromptSubmit` | `{"additionalContext":"..."}` (appended after the prompt), `{"decision":"block","reason":"..."}` |
| `Stop` | `{"decision":"block","reason":"..."}` |

A blocked prompt is not sent to the model; the reason is shown as a message. A blocking `Stop` hook feeds its reason back and the model continues. That can happen at most twice per run, so a hook that never relents cannot hold a run open forever; use `stopHookActive` to let go sooner.

## Examples

Refuse `rm -rf`:

```sh
#!/bin/sh
if jq -e '.toolInput.command | test("rm -rf")' >/dev/null; then echo "rm -rf is not allowed" >&2; exit 2; fi
```

Require the tests to pass before the model may stop:

```sh
#!/bin/sh
[ "$(jq -r .stopHookActive)" = "true" ] && exit 0
npm test >/tmp/test.log 2>&1 || { echo "npm test fails; fix it first. Tail: $(tail -5 /tmp/test.log)" >&2; exit 2; }
```

## Project hooks

A project's `.theoses/settings.json` can declare hooks too, but they run commands from a repository, so they are read only when the project is trusted (the same trust decision that gates project extensions and skills). They are added after your own hooks; a project can never remove or replace them, because the lists are concatenated and not merged.

## Notes

- Hooks run with the agent's privileges and full environment, secrets included. Treat a hook like any script you run yourself.
- Hooks run inside the operation, so a long hook keeps the session busy (and defers a self-update restart) until it returns.
- A `PreToolUse` hook that rewrites a path is respected by [file checkpoints](sessions.md): the checkpoint is taken after hooks and extensions, on the final input.
