import { mkdir, writeFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { getGeneratedImagesDir } from "../../config.ts";
import { processImage } from "../../utils/image-process.ts";
import type { ToolDefinition } from "../extensions/types.ts";

const generateImageSchema = Type.Object({
	prompt: Type.String({ description: "Detailed description of the image to generate" }),
});

export type GenerateImageToolInput = Static<typeof generateImageSchema>;

interface GeneratedImage {
	data: Buffer;
	mimeType: string;
	provider: string;
}

export interface GenerateImageOperations {
	generate: (prompt: string, signal?: AbortSignal) => Promise<GeneratedImage>;
}

const CLOUDFLARE_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-3.1-flash-lite-image";

async function generateWithCloudflare(prompt: string, signal?: AbortSignal): Promise<GeneratedImage> {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountId || !apiToken) throw new Error("CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN not set");
	const model = process.env.THEOSES_IMAGE_MODEL || DEFAULT_CLOUDFLARE_MODEL;
	const response = await fetch(`${CLOUDFLARE_BASE_URL}/accounts/${accountId}/ai/run/${model}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ prompt }),
		signal,
	});
	const contentType = response.headers.get("content-type") ?? "";
	if (!response.ok) {
		const message = await response.text();
		throw new Error(`Cloudflare Workers AI ${response.status}: ${message.slice(0, 200)}`);
	}
	if (contentType.startsWith("image/")) {
		return {
			data: Buffer.from(await response.arrayBuffer()),
			mimeType: contentType,
			provider: `Cloudflare Workers AI (${model})`,
		};
	}
	const body = (await response.json()) as { result?: { image?: string; images?: string[] } };
	const base64 = body.result?.image ?? body.result?.images?.[0];
	if (!base64) throw new Error("Cloudflare Workers AI: no image in response");
	return { data: Buffer.from(base64, "base64"), mimeType: "image/png", provider: `Cloudflare Workers AI (${model})` };
}

async function generateWithOpenRouter(prompt: string, signal?: AbortSignal): Promise<GeneratedImage> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
	const model = process.env.THEOSES_OPENROUTER_IMAGE_MODEL || DEFAULT_OPENROUTER_IMAGE_MODEL;
	const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: prompt }],
			modalities: ["image", "text"],
		}),
		signal,
	});
	if (!response.ok) {
		const message = await response.text();
		throw new Error(`OpenRouter ${response.status}: ${message.slice(0, 200)}`);
	}
	const body = (await response.json()) as {
		choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
	};
	const dataUrl = body.choices?.[0]?.message?.images?.[0]?.image_url?.url;
	const match = dataUrl?.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
	if (!match) throw new Error("OpenRouter: no image in response");
	return {
		data: Buffer.from(match[2] ?? "", "base64"),
		mimeType: match[1] ?? "image/png",
		provider: `OpenRouter (${model})`,
	};
}

async function generateWithPollinations(prompt: string, signal?: AbortSignal): Promise<GeneratedImage> {
	const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux-realism`;
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`Pollinations.ai ${response.status}`);
	const data = Buffer.from(await response.arrayBuffer());
	if (data.length < 100) throw new Error("Pollinations.ai: response too small to be an image");
	return { data, mimeType: response.headers.get("content-type") || "image/jpeg", provider: "Pollinations.ai" };
}

/** Cloudflare Workers AI (free tier) -> OpenRouter Gemini image model -> Pollinations.ai (free, no key), in that order. */
function createFallbackOperations(): GenerateImageOperations {
	return {
		generate: async (prompt, signal) => {
			for (const generate of [generateWithCloudflare, generateWithOpenRouter, generateWithPollinations]) {
				try {
					return await generate(prompt, signal);
				} catch {
					// Try the next provider in the chain.
				}
			}
			throw new Error("Image generation failed on Cloudflare Workers AI, OpenRouter, and Pollinations.ai");
		},
	};
}

function extensionFor(mimeType: string): string {
	if (mimeType.includes("png")) return ".png";
	if (mimeType.includes("webp")) return ".webp";
	if (mimeType.includes("gif")) return ".gif";
	return ".jpg";
}

export function createGenerateImageToolDefinition(options?: {
	operations?: GenerateImageOperations;
}): ToolDefinition<typeof generateImageSchema, undefined> {
	const operations = options?.operations ?? createFallbackOperations();

	return {
		name: "generate_image",
		label: "generate_image",
		description:
			"Generate an image from a text prompt (Cloudflare Workers AI, falling back to OpenRouter then Pollinations.ai). Saves the image to disk and returns it as a viewable attachment.",
		promptSnippet: "Generate an image from a text prompt",
		parameters: generateImageSchema,
		execute: async (_id, { prompt }: GenerateImageToolInput, signal) => {
			const generated = await operations.generate(prompt, signal);
			const dir = getGeneratedImagesDir();
			await mkdir(dir, { recursive: true });
			const path = `${dir}/${Date.now()}${extensionFor(generated.mimeType)}`;
			await writeFile(path, generated.data);

			const processed = await processImage(generated.data, generated.mimeType, {});
			if (!processed.ok) {
				return {
					content: [
						{ type: "text", text: `Image saved to ${path} (via ${generated.provider})\n${processed.message}` },
					],
					details: undefined,
				};
			}
			return {
				content: [
					{ type: "text", text: `Image saved to ${path} (via ${generated.provider})` },
					{ type: "image", data: processed.data, mimeType: processed.mimeType },
				],
				details: undefined,
			};
		},
	};
}
