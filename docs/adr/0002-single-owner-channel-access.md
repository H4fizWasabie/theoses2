# Single-owner channel access

Theoses2 remains a single-owner agent with no user accounts or role hierarchy. Telegram continues to authorize the owner by exact chat ID; the dashboard requires one configured owner credential, exchanged for an HTTP-only browser cookie and accepted as a bearer credential for automated clients. Sensitive dashboard APIs fail closed without it, while coding agents use isolated runtimes and credentials rather than production owner access. This gives the VPS defense in depth without turning Theoses2 into a multi-user product.
