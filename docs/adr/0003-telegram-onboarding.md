# Telegram onboarding contract

The dashboard onboarding configures both the Telegram bot token and the owner's numeric Telegram ID. The form instructs the owner to obtain the ID from `@userinfobot`, stores it using the existing `THEOSES_TELEGRAM_CHAT_ID` concept, and does not add a live connection-test action; the bot token remains secret while the ID is the channel allowlist.
