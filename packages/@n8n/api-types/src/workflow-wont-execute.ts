export const WORKFLOW_WONT_EXECUTE_CAUSES = ['restrictedNode'] as const;

export type WorkflowWontExecuteCause = (typeof WORKFLOW_WONT_EXECUTE_CAUSES)[number];
