export type MeshValidationCode =
	| "additional_property"
	| "digest_mismatch"
	| "invalid_format"
	| "invalid_id"
	| "invalid_type"
	| "invalid_value"
	| "missing_field"
	| "unsupported_schema";

export interface MeshValidationIssue {
	readonly code: MeshValidationCode;
	readonly path: string;
	readonly message: string;
	readonly operatorDetail?: string;
}

/** A safe-to-log validation error: it carries paths and rules, never raw payload values. */
export class MeshValidationError extends Error {
	readonly issues: readonly MeshValidationIssue[];

	constructor(issues: readonly MeshValidationIssue[]) {
		super(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
		this.name = "MeshValidationError";
		this.issues = Object.freeze([...issues]);
	}
}
