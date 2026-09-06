#!/usr/bin/env node
import { registerBunOAuthFlows } from "theoses-ai/bun-oauth";
import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { main } from "../main.ts";
import { registerBedrockProvider } from "./register-bedrock.ts";
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

restoreSandboxEnv();
registerBunOAuthFlows();
registerBedrockProvider();
process.env.THEOSES_CODING_AGENT = "true";
process.env.AI_AGENT = "theoses";
configureHttpDispatcher();
main(process.argv.slice(2));
