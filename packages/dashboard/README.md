# Theoses dashboard

The private dashboard provides a browser chat for dashboard sessions, read-only Telegram history, and a VPS-wide file workbench.

Run it behind Tailscale:

```bash
node dist/index.js
```

The server listens on `127.0.0.1:7788` by default. Set `THEOSES_DASHBOARD_PORT` or `THEOSES_DASHBOARD_HOST` when the Tailscale setup needs a different bind address.
