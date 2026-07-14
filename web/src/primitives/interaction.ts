import type { Anchor } from "./anchor";
import type { Checks } from "./checks";

export type Role = "human" | "ai";

export type AskIntent = "comment" | "question" | "blocker";
export type ResponseIntent = "accept" | "reject";
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
