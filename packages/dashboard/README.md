# Theoses dashboard

The private dashboard provides a browser chat for dashboard sessions, read-only Telegram history, and a VPS-wide file workbench.

Run it behind Tailscale:

```bash
THEOSES_DASHBOARD_TOKEN='generate-a-long-random-value' node dist/index.js
```

The server listens on `127.0.0.1:7788` by default. Set `THEOSES_DASHBOARD_PORT` or `THEOSES_DASHBOARD_HOST` when the Tailscale setup needs a different bind address.

The dashboard requires `THEOSES_DASHBOARD_TOKEN` for every API request. Sign in through the browser with that token, or send it as `Authorization: Bearer <token>` for automated clients. Keep the token in a protected environment file; do not put it in a URL or repository.
