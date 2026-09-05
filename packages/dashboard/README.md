# Theoses dashboard

The private dashboard provides a browser chat for dashboard sessions, read-only Telegram history, and a VPS-wide file workbench.

Run it behind Tailscale:

```bash
THEOSES_DASHBOARD_TOKEN='generate-a-long-random-value' node dist/index.js
```

The server listens on `127.0.0.1:7788` by default. Set `THEOSES_DASHBOARD_PORT` or `THEOSES_DASHBOARD_HOST` when the Tailscale setup needs a different bind address.

The dashboard requires `THEOSES_DASHBOARD_TOKEN` for every API request. Sign in through the browser with that token, or send it as `Authorization: Bearer <token>` for automated clients. Keep the token in a protected environment file; do not put it in a URL or repository.

Open Settings after signing in to configure Telegram. Enter the bot token and the owner's numeric Telegram ID. To find the ID, open `@userinfobot` in Telegram, send `/start`, and copy the `Id` value. The settings are saved to `~/.theoses/agent/theoses.env` with mode `0600`; configure the Telegram systemd service with `EnvironmentFile=/home/<owner>/.theoses/agent/theoses.env`, then restart the service. Saving settings does not restart it automatically.

## Persona

Theoses reads its persona (tone, character, standing instructions) from a `THEOSES.md` file. It's read fresh from disk on each session, so editing it takes effect immediately without restarting the dashboard or rebuilding.

Two places are checked:

- `~/.theoses/agent/THEOSES.md` — applies to every session on this machine, regardless of working directory.
- `THEOSES.md` in the session's working directory (or any ancestor directory) — overrides/extends the global persona for that project only.

Both are picked up automatically; there is no setting to enable this.
