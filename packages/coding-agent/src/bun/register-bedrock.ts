import { bedrockProviderModule } from "theoses-ai/bedrock-provider";
import { setBedrockProviderModule } from "theoses-ai/compat";

export function registerBedrockProvider(): void {
	setBedrockProviderModule(bedrockProviderModule);
}
