import "./AgentContextSection.css";
import { useEffect, useState } from "react";
import type {
  AgentContextSlice,
  AgentSessionRef,
  Cursor,
  DeliveredInteraction,
  Interaction,
} from "../types";
import type { SymbolIndex } from "../symbols";

interface Props {
  slice: AgentContextSlice | null;
  /** All sessions matched to this worktree (for the picker). */
  candidates: AgentSessionRef[];
  /** Current session file path so the picker knows what's selected. */
  selectedSessionFilePath: string | null;
  /** Loading state from the parent's fetch effect. */
  loading: boolean;
  /** Last error from the fetch, if any. */
  error: string | null;
  /**
   * Symbols defined by the current diff. Backtick-quoted spans in chat that
   * exact-match a known symbol become click-throughs into the diff. Symbols
   * not in this index render as plain `<code>` — that's the false-positive
   * guard.
   */
  symbols: SymbolIndex;
  /**
   * MCP-install detection + authoritative install line. Null while loading
   * or after the fetch failed. `installCommand` is rendered verbatim in the
   * click-to-copy chip — the server resolver picks the local-build form
   * when `mcp-server/dist/index.js` exists and falls back to the npx form
   * otherwise.
   */
  mcpStatus: { installed: boolean; installCommand: string } | null;
  /** Click on a symbol link → jump to its definition in the diff. */
  onJump: (c: Cursor) => void;
  /** Switch the active session — the parent re-fetches with the new pin. */
  onPickSession: (sessionFilePath: string) => void;
  /** Manually re-run the fetch (after an error, or to refresh on demand). */
  onRefresh: () => void;
  /**
   * Delivered comments for this worktree (newest first). Drives the
   * Delivered (N) details block between the transcript tail and the
   * composer. The list is bounded server-side at 200 — see
   * `DELIVERED_HISTORY_CAP` in `server/src/agent-queue.ts`.
   */
  delivered: DeliveredInteraction[];
  /**
   * ISO timestamp of the most recent successful `fetchDelivered` call.
   * `null` before any successful poll. Drives the failure-mode banner's
   * "last checked X min ago" copy.
   */
  lastSuccessfulPollAt: string | null;
  /**
   * `true` when the most recent `fetchDelivered` errored. Pips freeze
   * in last-known state; the panel-level banner surfaces the failure.
   */
  deliveredError: boolean;
  /**
   * `true` while an agent is in watch mode for this worktree — drives the
   * "Agent is watching" indicator so the reviewer knows comments deliver
   * live and they need not re-prompt. Polled off `GET /api/agent/replies`.
   */
  watching: boolean;
  /**
   * Agent-started threads — top-level Interactions whose first entry is
   * authored by the agent. Surfaced as a "Comments" rollup so a reviewer
   * lands on them even when they're outside the current cursor's hunk.
   * The inline render in DiffView is the primary surface; this is the
   * sidebar/panel-level overview.
   */
  agentStartedThreads: Array<{ threadKey: string; head: Interaction }>;
}

/** localStorage key for the "I installed it" dismiss flag. One flag per
 *  machine — not per-worktree, not per-account. */
const MCP_DISMISS_KEY = "shippable.mcpInstallDismissed";

export function AgentContextSection({
  slice,
  candidates,
  selectedSessionFilePath,
  loading,
  error,
  symbols,
  mcpStatus,
  onJump,
  delivered,
  lastSuccessfulPollAt,
  deliveredError,
  watching,
  agentStartedThreads,
  onPickSession,
  onRefresh,
}: Props) {
  // Note: we deliberately don't early-return on "no slice + no candidates";
  // Inspector only renders this section when the active changeset has a
  // worktreeSource, and in that case the user expects to see the panel even
  // when no Claude Code session matched. The empty state below carries that.

  return (
    <section className="inspector__sec ac">
      <div className="inspector__sec-h ac__h">
        <span>Agent context</span>
        {slice && (
          <span className="inspector__sec-count ac__live" title={`last event: ${slice.session.lastEventAt}`}>
            {isLive(slice.session.lastEventAt) ? "● live" : "○ idle"}
          </span>
        )}
        <button
          className="inspector__sec-jump ac__refresh"
          onClick={onRefresh}
          disabled={loading}
          title="re-fetch the agent-context slice"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      <McpInstallAffordance mcpStatus={mcpStatus} />

      {/* Server-restart hint — single line, rendered once when a worktree
        * is loaded. Inspector only mounts this section in that case, so
        * the hint follows the panel's lifecycle automatically. */}
      <div className="ac__restart-hint">
        Queue is in-memory — server restart drops unpulled comments.
      </div>

      {watching && (
        <div className="ac__watching" role="status">
          <span className="ac__watching-dot" aria-hidden>
            ●
          </span>
          Agent is watching — comments deliver live.
        </div>
      )}

      {deliveredError && (
        <div className="ac__poll-banner" role="status">
          Agent status unavailable — last checked{" "}
          {lastSuccessfulPollAt ? humanAgo(lastSuccessfulPollAt) : "—"}.
        </div>
      )}

      {error && (
        <div className="ac__err">
          {error} <button className="ac__err-retry" onClick={onRefresh}>retry</button>
        </div>
      )}

      {!slice && !loading && !error && (
        <div className="inspector__empty">No Claude Code session matched this worktree.</div>
      )}

      {loading && !slice && (
        <div className="inspector__empty">Reading transcripts…</div>
      )}

      {slice && (
        <>
          <SessionLine
            slice={slice}
            candidates={candidates}
            selectedSessionFilePath={selectedSessionFilePath}
            onPick={onPickSession}
          />
          <TaskBlock
            task={slice.task}
            followUps={slice.followUps}
            symbols={symbols}
            onJump={onJump}
          />
          <FilesTouched files={slice.filesTouched} />
          {slice.todos.length > 0 && <TodosBlock todos={slice.todos} />}
          <TranscriptBlock
            messages={slice.messages}
            symbols={symbols}
            onJump={onJump}
          />
          <Footer slice={slice} />
        </>
      )}

      <AgentStartedThreadsBlock threads={agentStartedThreads} />
      <DeliveredBlock delivered={delivered} />
    </section>
  );
}

/**
 * Newest-first list of threads the agent started on its own — fresh
 * top-level interactions (no parent reviewer entry, agent at the head).
 */
function AgentStartedThreadsBlock({
  threads,
}: {
  threads: Array<{ threadKey: string; head: Interaction }>;
}) {
  if (threads.length === 0) return null;
  return (
    <details className="ac__details ac__delivered" open>
      <summary className="ac__details-summary">
        Comments ({threads.length})
      </summary>
      <ul className="ac__delivered-list">
        {threads.map(({ threadKey, head }) => (
          <li key={head.id} className="ac__delivered-item">
            <span className="ac__delivered-loc">
              {head.anchorPath ?? threadKey}
            </span>
            <span className="ac__delivered-sep"> · </span>
            <span className="ac__delivered-kind">{head.intent}</span>
            <span className="ac__delivered-sep"> · </span>
            <span className="ac__delivered-time" title={head.createdAt}>
              {humanAgo(head.createdAt)}
            </span>
            <div className="ac__delivered-body">{clipBody(head.body, 80)}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Newest-first list of comments the agent has fetched. Hides at N=0 — there
 * is no Delivered block on a fresh worktree until the first ✓ flips. Reads
 * from the same polled list that drives per-reply pips, so the macro view
 * (this block) and the micro view (per-thread pip) stay in sync.
 *
 * The server caps history at 200 entries; when the cap is hit we suffix
 * "(showing last 200)" to the summary so the user knows older deliveries
 * have aged out. We treat `length === 200` as the cap-hit signal — the
 * server drops oldest beyond the cap, so the only way to land at exactly
 * 200 in a long-running session is to be at the cap.
 */
function DeliveredBlock({ delivered }: { delivered: DeliveredInteraction[] }) {
  if (delivered.length === 0) return null;
  const atCap = delivered.length === 200;
  return (
    <details className="ac__details ac__delivered">
      <summary className="ac__details-summary">
        Delivered ({delivered.length}){atCap && " (showing last 200)"}
      </summary>
      <ul className="ac__delivered-list">
        {delivered.map((d) => (
          <li key={d.id} className="ac__delivered-item">
            <span className="ac__delivered-loc">{formatLoc(d)}</span>
            <span className="ac__delivered-sep"> · </span>
            <span className="ac__delivered-kind">{d.target}</span>
            <span className="ac__delivered-sep"> · </span>
            <span className="ac__delivered-time" title={d.deliveredAt}>
              {humanAgo(d.deliveredAt)}
            </span>
            <div className="ac__delivered-body">{clipBody(d.body, 80)}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatLoc(d: DeliveredInteraction): string {
  return d.lines ? `${d.file}:${d.lines}` : d.file;
}

function clipBody(body: string, max: number): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

/**
 * "Live" if the matched session has produced an event in the last 60s.
 * Threshold lives here for now — see docs/features/agent-context-panel.md.
 */
function isLive(lastEventAt: string): boolean {
  const ms = Date.parse(lastEventAt);
  if (Number.isNaN(ms)) return false;
  return Date.now() - ms < 60_000;
}

function SessionLine({
  slice,
  candidates,
  selectedSessionFilePath,
  onPick,
}: {
  slice: AgentContextSlice;
  candidates: AgentSessionRef[];
  selectedSessionFilePath: string | null;
  onPick: (filePath: string) => void;
}) {
  const ago = humanAgo(slice.session.startedAt);
  const taskTitle = slice.session.taskTitle ?? "(untitled session)";
  if (candidates.length <= 1) {
    return (
      <div className="ac__sub">
        from session <em>"{truncate(taskTitle, 60)}"</em> · started {ago}
      </div>
    );
  }
  return (
    <div className="ac__sub">
      <select
        className="ac__sess-select"
        value={selectedSessionFilePath ?? slice.session.filePath}
        onChange={(e) => onPick(e.target.value)}
        title="multiple Claude Code sessions ran in this worktree — pick one"
      >
        {candidates.map((s) => (
          <option key={s.filePath} value={s.filePath}>
            {truncate(s.taskTitle ?? s.sessionId, 60)} · {humanAgo(s.startedAt)}
          </option>
        ))}
      </select>
    </div>
  );
}

function TaskBlock({
  task,
  followUps,
  symbols,
  onJump,
}: {
  task: string | null;
  followUps: string[];
  symbols: SymbolIndex;
  onJump: (c: Cursor) => void;
}) {
  if (!task && followUps.length === 0) return null;
  return (
    <div className="ac__block">
      <div className="ac__label">Task</div>
      {task && (
        <p className="ac__task">
          <MessageText text={task} symbols={symbols} onJump={onJump} />
        </p>
      )}
      {followUps.length > 0 && (
        <details className="ac__details">
          <summary className="ac__details-summary">
            + {followUps.length} follow-up{followUps.length === 1 ? "" : "s"}
          </summary>
          <ul className="ac__followups">
            {followUps.map((f, i) => (
              <li key={i}>
                <MessageText text={f} symbols={symbols} onJump={onJump} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function FilesTouched({ files }: { files: string[] }) {
  if (files.length === 0) return null;
  return (
    <div className="ac__block">
      <div className="ac__label">Files touched ({files.length})</div>
      <ul className="ac__files">
        {files.map((f) => (
          <li key={f} className="ac__file" title={f}>
            {basename(f)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TodosBlock({ todos }: { todos: { content: string; status: "pending" | "in_progress" | "completed" }[] }) {
  return (
    <details className="ac__details">
      <summary className="ac__details-summary">
        Plan ({todos.filter((t) => t.status === "completed").length}/{todos.length})
      </summary>
      <ul className="ac__todos">
        {todos.map((t, i) => (
          <li key={i} className={`ac__todo ac__todo--${t.status}`}>
            <span className="ac__todo-marker">
              {t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "·"}
            </span>
            <span className="ac__todo-text">{t.content}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function TranscriptBlock({
  messages,
  symbols,
  onJump,
}: {
  messages: { role: string; text: string; toolCalls: { oneLine: string }[] }[];
  symbols: SymbolIndex;
  onJump: (c: Cursor) => void;
}) {
  if (messages.length === 0) return null;
  // Show the last few messages by default; expand for the full slice. We
  // keep 6 here to capture user/assistant alternation rather than just
  // assistant turns.
  const tail = messages.slice(-6);
  return (
    <details className="ac__details">
      <summary className="ac__details-summary">
        Transcript tail ({messages.length} message{messages.length === 1 ? "" : "s"})
      </summary>
      <ul className="ac__msgs">
        {tail.map((m, i) => (
          <li key={i} className={`ac__msg ac__msg--${m.role}`}>
            <div className="ac__msg-role">{m.role}</div>
            {m.text && (
              <div className="ac__msg-text">
                <MessageText
                  text={truncate(m.text, 400)}
                  symbols={symbols}
                  onJump={onJump}
                />
              </div>
            )}
            {m.toolCalls.length > 0 && (
              <ul className="ac__tools">
                {m.toolCalls.map((tc, j) => (
                  <li key={j} className="ac__tool">
                    {truncate(tc.oneLine, 80)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Backtick-only tokenizer for chat content. We deliberately do not link
 * bare identifiers (those produce too many false positives in narrative
 * text). A backtick-quoted span that exact-matches a symbol defined in the
 * loaded ChangeSet becomes a click-through; everything else stays prose.
 *
 * Why no `RichText` reuse: that component links bare identifiers too,
 * which is the right call for AI plan output but the wrong call here.
 */
function MessageText({
  text,
  symbols,
  onJump,
}: {
  text: string;
  symbols: SymbolIndex;
  onJump: (c: Cursor) => void;
}) {
  const parts = tokenizeBackticks(text, symbols);
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === "text") return <span key={i}>{p.text}</span>;
        if (p.kind === "code")
          return (
            <code key={i} className="ac__code">
              {p.text}
            </code>
          );
        return (
          <button
            key={i}
            className="ac__sym"
            onClick={() => onJump(p.target)}
            title={`jump to ${p.text}`}
          >
            {p.text}
          </button>
        );
      })}
    </>
  );
}

type MsgPart =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "symbol"; text: string; target: Cursor };

const TICK_RE = /`([^`\n]+)`/g;

function tokenizeBackticks(text: string, symbols: SymbolIndex): MsgPart[] {
  const out: MsgPart[] = [];
  let lastEnd = 0;
  for (const m of text.matchAll(TICK_RE)) {
    const start = m.index ?? 0;
    if (start > lastEnd) {
      out.push({ kind: "text", text: text.slice(lastEnd, start) });
    }
    const inner = m[1];
    const target = symbols.get(inner.trim());
    if (target) {
      out.push({ kind: "symbol", text: inner, target });
    } else {
      out.push({ kind: "code", text: inner });
    }
    lastEnd = start + m[0].length;
  }
  if (lastEnd < text.length) {
    out.push({ kind: "text", text: text.slice(lastEnd) });
  }
  return out;
}

// ── MCP install affordance ────────────────────────────────────────────────
//
// Renders prominently at the top of the panel when the server hasn't seen a
// `shippable` MCP entry in the user's Claude Code config and the user
// hasn't manually dismissed the prompt. Two click-to-copy boxes: the
// install command and the magic phrase. Plus an "I installed it" dismiss
// button — for harnesses we can't programmatically detect, that's the only
// way to clear the prompt.
//
// Detection is an `installed: boolean` from the server, alongside an
// authoritative `installCommand` string. Slice-3 follow-up: the chip used
// to hardcode the npx install line, but until `@shippable/mcp-server`
// lands on npm that 404s. The server now resolves `mcp-server/dist/index.js`
// relative to its own source location and hands back the local-build line
// when present (and the npx form when not).

/**
 * Two magic phrases — one per direction of the loop. `check shippable` pulls
 * pending reviewer interactions via the `shippable_check_review_comments`
 * tool; `report back to shippable` posts replies (or fresh top-level
 * interactions) via `shippable_post_review_comment`. The descriptions on
 * both tools tune for implicit triggering, but a literal phrase is the
 * prompt-drift escape hatch — see docs/sdd/agent-reply-support/spec.md.
 */
const MAGIC_PHRASE_PULL = "check shippable";
const MAGIC_PHRASE_REPORT = "report back to shippable";
/**
 * `watch shippable` enters watch mode: the agent loops on
 * `shippable_watch_review_comments` and picks up every comment live, so the
 * reviewer prompts once instead of per batch. See
 * docs/sdd/watch-review-comments/spec.md.
 */
const MAGIC_PHRASE_WATCH = "watch shippable";

function McpInstallAffordance({
  mcpStatus,
}: {
  mcpStatus: { installed: boolean; installCommand: string } | null;
}) {
  // Read the dismiss flag synchronously on mount so the install section
  // doesn't briefly flash for users who already dismissed.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(MCP_DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  // While mcpStatus is still loading and the user hasn't dismissed yet,
  // render nothing — better than a flash of "set up" copy that disappears
  // when the fetch lands.
  if (mcpStatus === null && !dismissed) return null;

  if (dismissed || (mcpStatus && mcpStatus.installed)) {
    return (
      <div className="ac__mcp ac__mcp--ok">
        <span className="ac__mcp-ok">✓</span>
        <span className="ac__mcp-ok-text">MCP installed</span>
      </div>
    );
  }
  // After the two checks above, the dismiss flag is false AND either
  // `mcpStatus` is non-null or we've early-returned. Belt-and-suspenders
  // null-guard so the chip render below can read `installCommand` without
  // a non-null assertion.
  if (mcpStatus === null) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(MCP_DISMISS_KEY, "1");
    } catch {
      // Best-effort: if storage is wedged the panel keeps re-rendering the
      // affordance, which is annoying but not broken.
    }
    setDismissed(true);
  }

  return (
    <div className="ac__mcp">
      <div className="ac__mcp-line">
        <span className="ac__mcp-icon" aria-hidden>
          ⚙
        </span>
        <span className="ac__mcp-text">
          Install the Shippable MCP server so your agent can fetch review
          comments.
        </span>
      </div>
      <div className="ac__mcp-row">
        <div className="ac__mcp-label">Install:</div>
        <CopyChip text={mcpStatus.installCommand} />
      </div>
      <div className="ac__mcp-row">
        <div className="ac__mcp-label">Pull comments:</div>
        <CopyChip text={MAGIC_PHRASE_PULL} />
      </div>
      <div className="ac__mcp-row">
        <div className="ac__mcp-label">Report back:</div>
        <CopyChip text={MAGIC_PHRASE_REPORT} />
      </div>
      <div className="ac__mcp-row">
        <div className="ac__mcp-label">Watch live:</div>
        <CopyChip text={MAGIC_PHRASE_WATCH} />
      </div>
      <div className="ac__mcp-hint">
        Prompt <code>watch shippable</code> once — the agent then picks up each
        comment live as you write it, no re-prompting.
      </div>
      <div className="ac__mcp-actions">
        <button
          className="ac__mcp-dismiss"
          onClick={dismiss}
          title="hide this prompt — persisted per-machine"
        >
          I installed it
        </button>
      </div>
    </div>
  );
}

/** Click-to-copy chip with a brief "copied ✓" feedback. */
function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  // Cancel the timer on unmount so we don't setState after the panel
  // re-renders without us.
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard denied (insecure context, permission, etc.). Leave the
      // state alone so the user can copy by hand.
    }
  }

  return (
    <button
      type="button"
      className={`ac__mcp-chip${copied ? " ac__mcp-chip--copied" : ""}`}
      onClick={() => void copy()}
      title="click to copy"
    >
      <code className="ac__mcp-chip-code">{text}</code>
      <span className="ac__mcp-chip-feedback">
        {copied ? "copied ✓" : "copy"}
      </span>
    </button>
  );
}

function Footer({ slice }: { slice: AgentContextSlice }) {
  const parts: string[] = [];
  parts.push(`${slice.messages.length} turn${slice.messages.length === 1 ? "" : "s"}`);
  if (slice.tokensIn > 0) parts.push(`${formatTokens(slice.tokensIn)} in`);
  if (slice.tokensOut > 0) parts.push(`${formatTokens(slice.tokensOut)} out`);
  if (slice.durationMs > 0) parts.push(humanDuration(slice.durationMs));
  if (slice.model) parts.push(slice.model);
  return <div className="ac__footer">{parts.join(" · ")}</div>;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function humanAgo(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "?";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}
