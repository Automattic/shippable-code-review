import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  ChangeSet,
  Claim,
  EntryPoint,
  EvidenceRef,
  Question,
  ReviewPlan,
  StructureMap,
} from "../../web/src/types.ts";
import { buildStructureMap } from "../../web/src/plan.ts";
import { getCredential } from "./auth/store.ts";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";

const EvidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("description") }),
  z.object({ kind: z.literal("file"), path: z.string() }),
  z.object({ kind: z.literal("hunk"), hunkId: z.string() }),
  z.object({
    kind: z.literal("symbol"),
    name: z.string(),
    definedIn: z.string(),
  }),
]);

const ClaimSchema = z.object({
  text: z.string(),
  evidence: z.array(EvidenceRefSchema),
});

const EntryPointSchema = z.object({
  fileId: z.string(),
  hunkId: z.string().optional(),
  reason: ClaimSchema,
});

const QuestionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changeset") }),
  z.object({ kind: z.literal("file"), path: z.string() }),
  z.object({ kind: z.literal("hunk"), hunkId: z.string() }),
  z.object({
    kind: z.literal("symbol"),
    name: z.string(),
    definedIn: z.string(),
  }),
]);

const QuestionSchema = z.object({
  id: z.string(),
  type: z.enum(["q1", "q2"]),
  target: QuestionTargetSchema,
  prompt: z.string(),
  claudeAnswer: z.string(),
});

const PlanResponseSchema = z.object({
  intent: z.array(ClaimSchema),
  // No max here — the model sometimes returns more than the prompt asks for.
  // We truncate to 3 in `assemblePlan` after evidence validation, so we keep
  // the best-validated 3 instead of blowing up the whole response.
  entryPoints: z.array(EntryPointSchema),
  questions: z.array(QuestionSchema),
});

export type PlanResponse = z.infer<typeof PlanResponseSchema>;

const SYSTEM_PROMPT = `You are a senior code reviewer helping a human reviewer orient to a diff. Your job: given a ChangeSet (a structured diff) and a pre-computed StructureMap (files + symbol graph), produce:

1. **intent**: 2-5 claims describing what this ChangeSet does and why. Each claim must carry evidence pointing back into the diff.
2. **entryPoints**: up to 3 places the reviewer should start reading, ordered from best to worst starting point. Each entry point must have a fileId that exists in the ChangeSet.

## Evidence rules (non-negotiable)

Every claim you make MUST carry at least one evidence ref. Evidence refs come in four kinds:

- \`{ kind: "description" }\` — the ChangeSet.description text itself. Use when the claim restates the PR description.
- \`{ kind: "file", path: "<path>" }\` — cite a file by its path. The path MUST exactly match one in StructureMap.files.
- \`{ kind: "hunk", hunkId: "<id>" }\` — cite a specific hunk. The hunkId MUST match a hunk id from the provided diff.
- \`{ kind: "symbol", name: "<name>", definedIn: "<path>" }\` — cite a symbol. Both name and definedIn MUST match an entry in StructureMap.symbols.

Do NOT fabricate paths, hunk ids, or symbol names. If you cannot cite evidence, do not make the claim.

## Style for intent claims

- Start each with a concrete verb ("Adds", "Refactors", "Introduces", "Removes", "Wires up").
- One sentence. No hedging, no "this PR seems to".
- Prefer claims the reviewer couldn't trivially read off the file list (describe *what the change is doing*, not just *what files changed*).
- If the ChangeSet description is substantive, include a claim with \`{ kind: "description" }\` evidence that restates it.

## Style for entryPoints

- Prefer files that define symbols referenced by other files (roots of the diff's dependency graph).
- Files that introduce **exported** symbols are also strong entry points, even when nothing in the diff consumes them yet — they're the API surface a reviewer needs to evaluate first. A symbol's \`exported\` flag in StructureMap.symbols tells you whether it's part of the file's public surface.
- Test files are good secondary entry points — they describe intended behavior.
- Each entry point's reason must explain *why start here*, not just *what's here*.
- If a specific hunk is the best starting point (e.g., the main definition), include its hunkId.

## StructureMap shape

\`StructureMap.symbols\` lists symbols defined in the diff. Each entry is \`{ name, definedIn, referencedIn, exported }\`:

- \`referencedIn\` is the set of *other files in this ChangeSet* that consume the symbol. An empty array doesn't mean "unused" — it means "no in-diff consumer," which is normal for newly exported APIs.
- \`exported: true\` means the declaration carries the \`export\` keyword. Use this to distinguish API additions from internal helpers when framing claims (e.g., "Adds public X" vs "Adds internal helper Y"). Non-exported symbols with zero in-diff consumers are omitted from the map entirely; you won't see them.

## Elided files

To keep the diff under token limits, files that are auto-generated (e.g. \`package-lock.json\`) or that match common binary asset extensions are listed in the diff with their path and status but **without** hunk content — they appear as \`### <path> (<status>) — content elided: <reason>\`. Treat their content as unreviewable here, but you can still cite them with \`{ kind: "file", path: "..." }\` evidence for claims like "bumps dependency X" inferred from the rest of the changeset.

## Comprehension questions

In addition to intent and entryPoints, return **3 to 8 comprehension questions** that test whether a reviewer understands this change. They are not graded — the reviewer compares their answer to yours and self-evaluates. Write \`claudeAnswer\` the way a reviewer would, not the way a doc would.

Distribute across scope:
- Roughly **one** changeset-level Q1 ("what does this PR do?"). Target: \`{ kind: "changeset" }\`.
- **Most** as file-level Q1s. Target: \`{ kind: "file", path: <path from StructureMap.files> }\`.
- **One or two** as hunk- or symbol-level Q2s. Target: \`{ kind: "hunk", hunkId: <id> }\` or \`{ kind: "symbol", name, definedIn }\`.

Question types (set \`type\` accordingly):
- \`"q1"\`: short-prose "what does this do?" — fits changeset, file, or symbol targets.
- \`"q2"\`: "will this break if we send it X?" — fits hunk or symbol targets where there's a concrete input value and an expected behavior derivable from the diff. **Include the concrete input value in the prompt** (e.g., "What happens if loadPrefs is called when localStorage has the string \"undefined\"?").

For every question:
- \`id\`: a short stable string unique within the response (e.g., \`"q-cs"\`, \`"q-file-storage"\`, \`"q-hunk-1"\`).
- \`target\` MUST resolve in the StructureMap (the same validator that drops bad claim evidence drops bad question targets).
- \`prompt\`: ONE sentence. End with a question mark.
- \`claudeAnswer\`: 1–3 short sentences. Concrete, falsifiable, grounded in the diff.

Do NOT emit questions that:
- Depend on context outside the diff.
- Have only stylistic answers ("is this readable?").
- Could be answered by reading the file list alone.

You will be called via structured output (JSON schema). Return only the schema-conformant object. Do not include prose outside the structured output.`;

export async function generatePlan(
  cs: ChangeSet,
): Promise<{ plan: ReviewPlan; questions: Question[] }> {
  const map = buildStructureMap(cs);
  const userContent = buildUserMessage(cs, map);

  await maybeLogPlanRequest(cs, userContent);

  const apiKey = getCredential({ kind: "anthropic" });
  if (!apiKey) {
    // The /api/plan handler short-circuits with 503 when the store is empty,
    // so reaching here implies the credential was cleared between the gate
    // and SDK construction. Throw rather than let the SDK fall back to
    // process.env.ANTHROPIC_API_KEY — env reads are no longer authoritative.
    throw new Error("anthropic_key_missing");
  }
  const client = new Anthropic({ apiKey });

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
    output_config: {
      format: zodOutputFormat(PlanResponseSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error(
      `Claude returned no parsed output (stop_reason: ${response.stop_reason})`,
    );
  }

  return assemblePlan(cs, map, response.parsed_output);
}

export function buildUserMessage(cs: ChangeSet, map: StructureMap): string {
  const lines: string[] = [];
  lines.push(`# ChangeSet: ${cs.id}`);
  lines.push(`Title: ${cs.title}`);
  lines.push(`Branch: ${cs.branch} → ${cs.base}`);
  lines.push(`Author: @${cs.author}`);
  lines.push("");
  lines.push("## Description");
  lines.push(cs.description.trim() || "(no description)");
  lines.push("");
  lines.push("## StructureMap (pre-computed)");
  lines.push("```json");
  lines.push(JSON.stringify(map, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Diff");
  for (const file of cs.files) {
    const elide = elideReason(file.path);
    if (elide) {
      lines.push(`### ${file.path} (${file.status}) — content elided: ${elide}`);
      continue;
    }
    lines.push(`### ${file.path} (${file.status})`);
    for (const h of file.hunks) {
      lines.push(`#### hunk ${h.id} — ${h.header}`);
      lines.push("```");
      for (const l of h.lines) {
        const prefix = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
        lines.push(`${prefix}${l.text}`);
      }
      lines.push("```");
    }
  }
  return lines.join("\n");
}

// Files whose diff content costs many tokens and offers nothing useful for the
// plan. Binary diffs are already filtered upstream (parseDiff.ts + the worktree
// changeset endpoint), but the extension check stays as a defensive backstop
// in case a future ingest path lets one through.
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
]);

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff",
  "pdf", "zip", "tar", "gz", "tgz", "bz2", "7z", "rar",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "wav", "ogg", "webm",
  "wasm", "exe", "dll", "so", "dylib",
]);

// Opt-in debug dump of the exact payload we send to Claude. Off by default
// because diffs may include proprietary code; set SHIPPABLE_PLAN_LOG_DIR to a
// path you control to enable. Failure to write is logged but never raised —
// debug logging must not break the request path.
async function maybeLogPlanRequest(
  cs: ChangeSet,
  userContent: string,
): Promise<void> {
  const dir = process.env.SHIPPABLE_PLAN_LOG_DIR;
  if (!dir) return;
  try {
    await mkdir(dir, { recursive: true });
    const safeId = cs.id.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `plan-${safeId}-${stamp}.json`);
    const payload = {
      model: MODEL,
      changesetId: cs.id,
      userContentBytes: Buffer.byteLength(userContent, "utf8"),
      system: SYSTEM_PROMPT,
      user: userContent,
    };
    await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
    console.log(`[plan] wrote request dump to ${file}`);
  } catch (err) {
    console.warn("[plan] failed to write request dump:", err);
  }
}

export function elideReason(path: string): string | null {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (LOCKFILE_BASENAMES.has(basename)) return "auto-generated lockfile";
  const dot = basename.lastIndexOf(".");
  if (dot >= 0) {
    const ext = basename.slice(dot + 1).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return `binary (.${ext})`;
  }
  return null;
}

export function assemblePlan(
  cs: ChangeSet,
  map: StructureMap,
  parsed: PlanResponse,
): { plan: ReviewPlan; questions: Question[] } {
  const fileIds = new Set(cs.files.map((f) => f.id));
  const filePaths = new Set(map.files.map((f) => f.path));
  const hunkIds = new Set<string>();
  for (const f of cs.files) {
    for (const h of f.hunks) hunkIds.add(h.id);
  }
  const symbols = new Map(
    map.symbols.map((s) => [`${s.name}@${s.definedIn}`, s]),
  );

  const resolveEvidence = (refs: EvidenceRef[]): EvidenceRef[] =>
    refs.filter((ref) => {
      switch (ref.kind) {
        case "description":
          return cs.description.trim().length > 0;
        case "file":
          return filePaths.has(ref.path);
        case "hunk":
          return hunkIds.has(ref.hunkId);
        case "symbol":
          return symbols.has(`${ref.name}@${ref.definedIn}`);
      }
    });

  const resolveClaim = (claim: Claim): Claim | null => {
    const evidence = resolveEvidence(claim.evidence);
    if (evidence.length === 0) return null;
    return { text: claim.text, evidence };
  };

  const intent = parsed.intent
    .map(resolveClaim)
    .filter((c): c is Claim => c !== null);

  const entryPoints: EntryPoint[] = [];
  for (const ep of parsed.entryPoints) {
    if (!fileIds.has(ep.fileId)) continue;
    const file = cs.files.find((f) => f.id === ep.fileId);
    if (!file) continue;
    let hunkId = ep.hunkId;
    if (hunkId && !file.hunks.some((h) => h.id === hunkId)) {
      hunkId = undefined;
    }
    const reason = resolveClaim(ep.reason);
    if (!reason) continue;
    entryPoints.push({ fileId: ep.fileId, hunkId, reason });
    if (entryPoints.length >= 3) break;
  }

  const questions: Question[] = [];
  for (const raw of parsed.questions) {
    const t = raw.target;
    let ok = false;
    switch (t.kind) {
      case "changeset":
        ok = true;
        break;
      case "file":
        ok = filePaths.has(t.path);
        break;
      case "hunk":
        ok = hunkIds.has(t.hunkId);
        break;
      case "symbol":
        ok = symbols.has(`${t.name}@${t.definedIn}`);
        break;
    }
    if (ok) questions.push(raw);
  }

  return {
    plan: { headline: cs.title, intent, map, entryPoints },
    questions,
  };
}
