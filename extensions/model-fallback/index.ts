/**
 * Model fallback — retry a refused Claude response on a different, normally
 * aligned provider (GPT), to test whether a refusal was a false positive.
 *
 * This is deliberately NOT a "route around any refusal" system: the fallback
 * target is an ordinary provider with its own safety policy (OpenAI/GPT),
 * never a model marketed as having no refusals. If GPT also refuses, this
 * extension accepts that and stops — it does not escalate further. See
 * PLAN.md's "Model fallback (false-positive testing)" section for the
 * reasoning and the explicit thing this is not.
 *
 * Mechanism, confirmed against the real virtual-models API
 * (docs/virtual-models.md, examples/extensions/jev-router.ts in the
 * installed @earendil-works/pi-coding-agent package):
 *
 *  - `agent_end` looks at the finalized messages for this run. If the last
 *    assistant message came from the primary provider and looks like a
 *    refusal, it's remembered (closure flag) for `agent_settled`.
 *  - `agent_settled` fires once the run has *fully* settled (no pending
 *    retry/compaction/continuation) — the documented safe place to call
 *    `pi.sendMessage(..., { triggerTurn: true })` to start a new request.
 *  - The `foreman-hybrid` virtual model's `route()` is stateless on purpose:
 *    it looks at the tail of `request.messages` since the last user message
 *    and picks GPT only if the most recent assistant reply in that tail was
 *    a refusal from the primary provider. Once GPT has answered (refusal or
 *    not), the tail's last assistant message is no longer from the primary
 *    provider, so this can't loop — same pattern jev-router.ts uses
 *    (`editedThisTurn`) to inspect conversation history instead of carrying
 *    fragile cross-call state.
 *
 * NOT YET VERIFIED LIVE: no `pi` runtime or OpenAI credential was available
 * in the environment this was built in. Typechecked against the real API;
 * logic not exercised against a real model response. See README.md.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const PRIMARY_PROVIDER = "anthropic";
const FALLBACK_PROVIDER = "openai";

// Override with env vars once you've confirmed the exact catalog ids for
// your account (`/models` inside pi, or https://pi.dev/models) -- these are
// reasonable guesses, not verified against a live catalog.
const PRIMARY_MODEL_ID = process.env.FOREMAN_PRIMARY_MODEL ?? "claude-sonnet-4-5";
const FALLBACK_MODEL_ID = process.env.FOREMAN_FALLBACK_MODEL ?? "gpt-4o-mini";

const VIRTUAL_PROVIDER = "foreman";
const VIRTUAL_MODEL_ID = "hybrid";

/**
 * Heuristic refusal detector. Deliberately conservative: real refusals are
 * short and open with one of these patterns. A long answer that happens to
 * contain "I can't" mid-paragraph should NOT match, or every legitimate
 * "here's what I can't do, here's what I can" answer gets misrouted.
 */
const REFUSAL_OPENERS: RegExp[] = [
	/^i can'?t (help|assist|do|provide|create|write)/i,
	/^i('m| am) (not able|unable) to/i,
	/^i won'?t /i,
	/^sorry,? (but )?i can'?t/i,
	/^i must decline/i,
	/^n[ãa]o posso (ajudar|fazer|criar|escrever|auxiliar)/i,
	/^desculpe,? (mas )?n[ãa]o posso/i,
	/^infelizmente,? n[ãa]o posso/i,
];
const MAX_REFUSAL_LENGTH = 600; // refusals are short; a long reply isn't one

function extractText(message: Message): string {
	if (message.role !== "assistant") return "";
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
}

function looksLikeRefusal(text: string): boolean {
	if (!text || text.length > MAX_REFUSAL_LENGTH) return false;
	return REFUSAL_OPENERS.some((re) => re.test(text));
}

function lastAssistantSinceLastUser(messages: readonly Message[]): Message | undefined {
	const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
	const tail = messages.slice(lastUserIndex + 1);
	for (let i = tail.length - 1; i >= 0; i--) {
		if (tail[i].role === "assistant") return tail[i];
	}
	return undefined;
}

function routeTo(ctx: ExtensionContext, provider: string, modelId: string, thinkingLevel: ModelRouteRequest["thinkingLevel"]): ModelRoute {
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		throw new Error(
			`foreman-pi model-fallback: ${provider}/${modelId} is not in the catalog. ` +
				`Check the exact id with /models or https://pi.dev/models and set ` +
				`${provider === PRIMARY_PROVIDER ? "FOREMAN_PRIMARY_MODEL" : "FOREMAN_FALLBACK_MODEL"}.`,
		);
	}
	return { model, thinkingLevel };
}

export default function (pi: ExtensionAPI) {
	let pendingFallbackRetry = false;

	pi.registerVirtualModel({
		provider: VIRTUAL_PROVIDER,
		id: VIRTUAL_MODEL_ID,
		name: "Foreman Hybrid (Claude, GPT fallback on refusal)",
		thinkingLevels: ["off", "low", "medium", "high"],
		route(request, ctx) {
			const lastAssistant = lastAssistantSinceLastUser(request.messages);
			const primaryJustRefused =
				lastAssistant?.role === "assistant" &&
				lastAssistant.provider === PRIMARY_PROVIDER &&
				looksLikeRefusal(extractText(lastAssistant));

			if (primaryJustRefused) {
				const fallback = ctx.modelRegistry.find(FALLBACK_PROVIDER, FALLBACK_MODEL_ID);
				if (fallback && ctx.modelRegistry.hasConfiguredAuth(fallback)) {
					return { model: fallback, thinkingLevel: request.thinkingLevel };
				}
				// No usable fallback credential -- stay on the primary rather than
				// throw mid-turn. The agent_settled handler below will have already
				// told the user why no retry happened.
			}

			return routeTo(ctx, PRIMARY_PROVIDER, PRIMARY_MODEL_ID, request.thinkingLevel);
		},
	});

	pi.on("agent_end", async (event) => {
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		pendingFallbackRetry = !!(
			lastAssistant?.role === "assistant" &&
			lastAssistant.provider === PRIMARY_PROVIDER &&
			looksLikeRefusal(extractText(lastAssistant))
		);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!pendingFallbackRetry) return;
		pendingFallbackRetry = false;

		const fallback = ctx.modelRegistry.find(FALLBACK_PROVIDER, FALLBACK_MODEL_ID);
		if (!fallback || !ctx.modelRegistry.hasConfiguredAuth(fallback)) {
			pi.sendMessage({
				customType: "foreman-fallback-unavailable",
				display: true,
				content:
					`The last response looked like a refusal, but no usable credential is configured ` +
					`for ${FALLBACK_PROVIDER}/${FALLBACK_MODEL_ID} (needs an API key with billing, not a ` +
					`ChatGPT subscription — set ${FALLBACK_PROVIDER.toUpperCase()}_API_KEY). Not retrying.`,
			});
			return;
		}

		pi.sendMessage(
			{
				customType: "foreman-fallback-retry",
				display: true,
				content:
					"The previous response looked like a refusal. Retrying the same request on the " +
					`configured fallback model (${FALLBACK_PROVIDER}/${FALLBACK_MODEL_ID}) to check whether ` +
					"this was a false positive, as explicitly requested by the user for this project.",
			},
			{ triggerTurn: true },
		);
	});
}
