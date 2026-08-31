import { MeshValidationError } from "./errors";

export const MESH_ID_PREFIX = {
	session: "ses_",
	task: "task_",
	plan: "plan_",
	assignment: "asg_",
	job: "job_",
	event: "evt_",
	artifact: "art_",
	checkpoint: "cp_",
	approval: "apr_",
	evidence: "evd_",
	receipt: "rcpt_",
	node: "node_",
	model: "model_",
} as const;

export type MeshIdKind = keyof typeof MESH_ID_PREFIX;

const ID_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,155}$/;

export function assertMeshId(value: unknown, kind: MeshIdKind, path: string): string {
	const prefix = MESH_ID_PREFIX[kind];
	if (typeof value === "string" && value.startsWith(prefix) && ID_SUFFIX.test(value.slice(prefix.length))) return value;
	throw new MeshValidationError([
		{
			code: "invalid_id",
			path,
			message: `must be a ${kind} ID beginning with ${prefix}`,
			operatorDetail: `required-prefix:${prefix}`,
		},
	]);
}

export function isMeshId(value: unknown, kind: MeshIdKind): value is string {
	try {
		assertMeshId(value, kind, "$id");
		return true;
	} catch (error) {
		if (error instanceof MeshValidationError) return false;
		throw error;
	}
}
