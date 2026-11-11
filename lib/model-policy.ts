/**
 * Pure model/thinking resolution for a worker agent. No model ids live here or
 * in agents/*.md: tiers resolve only through env vars, otherwise the worker
 * inherits the session model (which may be the virtual `foreman/hybrid`).
 *
 * model:    FOREMAN_MODEL_<ROLE> > frontmatter `model` > FOREMAN_MODEL_<TIER> > session model
 * thinking: FOREMAN_THINKING_<ROLE> > frontmatter `thinking` > session thinking level
 *
 * <ROLE> is the agent name upper-cased with non-alphanumerics as `_`
 * (`plan-step-builder` -> `PLAN_STEP_BUILDER`); <TIER> is STRONG|MID|CHEAP.
 */
import { isThinkingLevel, type AgentConfig, type ThinkingLevel } from "./agents.ts";

export interface ResolvedModel {
	/** Undefined = pass no `--model`, i.e. inherit the session model. */
	model?: string;
	/** Undefined = pass no `--thinking`. */
	thinking?: string;
}

export function roleEnvKey(name: string): string {
	return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
	const v = env[key]?.trim();
	return v ? v : undefined;
}

export function resolveModel(
	agent: Pick<AgentConfig, "name" | "model" | "tier" | "thinking">,
	env: Record<string, string | undefined>,
	session: { model?: string; thinking?: string } = {},
): ResolvedModel {
	const role = roleEnvKey(agent.name);
	const model =
		envValue(env, `FOREMAN_MODEL_${role}`) ??
		agent.model ??
		(agent.tier ? envValue(env, `FOREMAN_MODEL_${agent.tier.toUpperCase()}`) : undefined) ??
		session.model;

	const roleThinking = envValue(env, `FOREMAN_THINKING_${role}`);
	const thinking: string | undefined =
		(isThinkingLevel(roleThinking) ? (roleThinking as ThinkingLevel) : undefined) ?? agent.thinking ?? session.thinking;

	return { model, thinking };
}
