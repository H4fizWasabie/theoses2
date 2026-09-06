import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type TheosesCommandContext, theosesCommand } from "./commands/pi.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";

export type ExperimentalCliContext = TheosesCommandContext & ServerCommandContext & ClientCommandContext;

export const experimentalCli = theosesCommand.command(serverCommand).command(clientCommand);
