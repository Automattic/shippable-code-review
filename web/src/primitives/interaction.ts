import { isInteractionAnchor, type Anchor } from "./anchor";
import { isCompleteChecks, type Checks } from "./checks";

export type Role = "human" | "ai";

export type AskIntent = "comment" | "question" | "blocker";
// "respond" is the neutral reply — an answer, a follow-up, "fixed, look again".
// accept/reject remain the typed verdict record; a blocker/finding thread stays
// unresolved until a verdict reply exists, so `respond` never substitutes for a
// decision (docs/plans/v1-incremental-migration.md, intent-vocabulary decision).
export type ResponseIntent = "accept" | "reject" | "respond";
export type Intent = AskIntent | ResponseIntent;

export type Interaction = {
  id: string;
  changesetId: string;
  anchor: Anchor;
  authorId: string; // → users.id
  intent: Intent;
  body: string; // markdown
  createdAt: string;
  updatedAt: string;
};

export type AgentInteraction = Interaction & {
  checks: Checks;
  rationale: string;
  suggestedFix?: string;
};

const ASK_INTENTS: ReadonlySet<Intent> = new Set<Intent>(["comment", "question", "blocker"]);

export type WriteInput = {
  anchor: Anchor;
  intent: Intent;
  role: Role;
  checks?: unknown;
  rationale?: string;
  suggestedFix?: string;
  parentExists: boolean;
};

export function validateInteractionWrite(
  input: WriteInput,
): { ok: true } | { ok: false; error: string } {
  const isAsk = ASK_INTENTS.has(input.intent);
  const onInteraction = isInteractionAnchor(input.anchor);

  if (isAsk && onInteraction) return { ok: false, error: "asks must root on code/changeset" };
  if (!isAsk && !onInteraction) return { ok: false, error: "responses must reply to an interaction" };
  if (onInteraction && !input.parentExists) return { ok: false, error: "parent interaction does not exist" };

  if (input.role === "ai") {
    if (!isCompleteChecks(input.checks)) return { ok: false, error: "ai interactions require complete checks" };
    if (!input.rationale || input.rationale.trim() === "") return { ok: false, error: "ai interactions require a rationale" };
  } else {
    if (input.checks !== undefined || input.rationale !== undefined || input.suggestedFix !== undefined) {
      return { ok: false, error: "human interactions carry no ai-only fields" };
    }
  }
  return { ok: true };
}
