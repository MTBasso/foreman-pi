/**
 * The single list of worker roles. Pure: no imports. Used by the coordinator
 * (validation), the `foreman_delegate` enum and the drift lints.
 * Each role has a matching `agents/<role>.md`.
 */
export const ROLES = [
	"planner",
	"frontend-dev",
	"backend-dev",
	"qa",
	"qa-bugfix",
	"plan-step-builder",
	"codebase-auditor",
	"reviewer",
	"shipper",
] as const;
export type Role = (typeof ROLES)[number];
