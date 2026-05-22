import { useMemo, useState } from "react";
import "./ReviewPlanView.css";
import type {
  Claim,
  EntryPoint,
  EvidenceRef,
  ReviewPlan,
  StructureMap,
  StructureMapFile,
  ChangeSet,
  ChangeSetCommit,
  CodeGraphNode,
} from "../types";
import { buildPlanDiagram } from "../planDiagram";
import { Reference } from "./Reference";
import { CopyButton } from "./CopyButton";
import { PlanDiagramView } from "./PlanDiagramView";
import { MarkdownView } from "./MarkdownView";

interface Props {
  plan: ReviewPlan;
  /** Called when the reviewer chooses an entry point. Optional for gallery use. */
  onJumpToEntry?: (entry: EntryPoint) => void;
  /** Called when any evidence reference is clicked (file, hunk, symbol). */
  onNavigate?: (ev: EvidenceRef) => void;
  /** "idle" before any AI request has run; "loading" while in flight;
   *  "ready" once the AI plan has replaced the rule-based one;
   *  "fallback" if the request errored. Omit for the gallery / rule-only
   *  rendering path. */
  status?: "idle" | "loading" | "ready" | "fallback";
  /** Error message to surface when status === "fallback". */
  error?: string;
  /** Whether an Anthropic credential is configured. Drives the new
   *  AI-forward layout (hide static map while loading and once AI is
   *  ready) plus the privacy chip and Regenerate button. When false the
   *  view falls back to the original full-Map layout. */
  aiEnabled?: boolean;
  /** Click handler for the Regenerate button. Shown only when
   *  `aiEnabled` and `status` is "ready" or "fallback". */
  onRegenerate?: () => void;
  /** Click handler for the "Configure API key" link surfaced in the
   *  no-key path. Should open the credentials/settings panel. */
  onConfigureKey?: () => void;
  changeset?: ChangeSet;
  /** Reload the diff filtered to a single commit. When provided, commit SHAs
   *  in the per-commit list render as clickable buttons. */
  onFilterToCommit?: (sha: string) => void;
}

export function ReviewPlanView({
  plan,
  onJumpToEntry,
  onNavigate,
  status,
  error,
  aiEnabled,
  onRegenerate,
  onConfigureKey,
  changeset,
  onFilterToCommit,
}: Props) {
  const [showDiagram, setShowDiagram] = useState(false);
  const [includeMarkdown, setIncludeMarkdown] = useState(false);
  const diagram = useMemo(
    () =>
      showDiagram
        ? buildPlanDiagram(plan, changeset?.graph, { includeMarkdown })
        : null,
    [changeset?.graph, plan, showDiagram, includeMarkdown],
  );

  // Auto-fire hides the static analysis once AI has succeeded; the diff
  // structure is busy and competes with the AI claims. While loading it is
  // hidden too, so the first paint is just headline + PR body + commits.
  // On fallback we revert to today's layout so the user is not left blank.
  const hideStaticMap =
    !!aiEnabled && (status === "loading" || status === "ready");

  return (
    <section className="plan">
      <header className="plan__h">
        <div className="plan__h-row">
          <div className="plan__h-titles">
            <div className="plan__h-label">plan</div>
            <h1 className="plan__headline">{plan.headline}</h1>
          </div>
          <PlanHeaderActions
            aiEnabled={aiEnabled}
            status={status}
            onRegenerate={onRegenerate}
            onConfigureKey={onConfigureKey}
          />
        </div>
        {status === "loading" && (
          <div className="plan__h-status">Claude is reading the diff…</div>
        )}
        {status === "fallback" && (
          <div className="plan__h-status plan__h-status--err errrow">
            <span className="errrow__msg">
              AI plan failed — showing rule-based fallback{error ? `: ${error}` : ""}
            </span>
            {error && <CopyButton text={error} />}
          </div>
        )}
      </header>

      <IntentSection
        intent={plan.intent}
        changeset={changeset}
        onNavigate={onNavigate}
        hideStaticFiles={hideStaticMap}
      />
      {hideStaticMap && status === "ready" && plan.entryPoints.length > 0 && (
        <EntryPointsSection
          map={plan.map}
          entryPoints={plan.entryPoints}
          onJumpToEntry={onJumpToEntry}
          onNavigate={onNavigate}
        />
      )}
      {changeset?.commits && changeset.commits.length > 0 && (
        <CommitsSection
          changeset={changeset}
          onNavigate={onNavigate}
          onFilterToCommit={onFilterToCommit}
        />
      )}
      {hideStaticMap ? (
        status === "ready" && (
          <CollapsedMapSection
            map={plan.map}
            entryPoints={plan.entryPoints}
            onNavigate={onNavigate}
            showDiagram={showDiagram}
            onToggleDiagram={() => setShowDiagram((value) => !value)}
            diagram={diagram}
            includeMarkdown={includeMarkdown}
            onToggleMarkdown={() => setIncludeMarkdown((value) => !value)}
          />
        )
      ) : (
        <MapSection
          map={plan.map}
          entryPoints={plan.entryPoints}
          onJumpToEntry={onJumpToEntry}
          onNavigate={onNavigate}
          showDiagram={showDiagram}
          onToggleDiagram={() => setShowDiagram((value) => !value)}
          diagram={diagram}
          includeMarkdown={includeMarkdown}
          onToggleMarkdown={() => setIncludeMarkdown((value) => !value)}
        />
      )}
    </section>
  );
}

function PlanHeaderActions({
  aiEnabled,
  status,
  onRegenerate,
  onConfigureKey,
}: {
  aiEnabled?: boolean;
  status?: Props["status"];
  onRegenerate?: () => void;
  onConfigureKey?: () => void;
}) {
  if (aiEnabled) {
    const canRegenerate =
      (status === "ready" || status === "fallback") && !!onRegenerate;
    return (
      <div className="plan__h-meta">
        <span
          className="plan__chip plan__chip--ai"
          title="Diffs are sent to Claude when you open a review"
        >
          Auto-sending diff to Claude
        </span>
        {canRegenerate && (
          <button
            type="button"
            className="plan__h-btn"
            onClick={onRegenerate}
          >
            regenerate
          </button>
        )}
      </div>
    );
  }
  if (status === "idle" && onConfigureKey) {
    return (
      <div className="plan__h-meta">
        <button
          type="button"
          className="plan__h-link"
          onClick={onConfigureKey}
        >
          configure api key to enable AI plan
        </button>
      </div>
    );
  }
  return null;
}

function IntentSection({
  intent,
  changeset,
  onNavigate,
  hideStaticFiles,
}: {
  intent: Claim[];
  changeset?: ChangeSet;
  onNavigate?: (ev: EvidenceRef) => void;
  /** Suppress the structure-derived file list nested inside the PR body.
   *  When AI is enabled the same list reappears under "all files" at the
   *  bottom of the overlay, so showing it twice would just be noise. */
  hideStaticFiles?: boolean;
}) {
  const hasClaims = intent.length > 0;
  // `prSource.body` is the author-written PR description. Keep it visible
  // alongside the AI claims — the claims are Claude's synthesis, the body is
  // the source of truth the reviewer wants to compare against.
  const prBody = (changeset?.prSource?.body ?? "").trim();
  // `description` is the synthesised single-commit subject worktree loads fall
  // back to when there is no PR body. Drop it once AI claims exist — the
  // claims describe the change better than its subject line.
  const fallbackDescription =
    !prBody && !hasClaims ? (changeset?.description ?? "").trim() : "";
  const hasCommits = !!changeset?.commits && changeset.commits.length > 0;

  if (!hasClaims && !prBody && !fallbackDescription && !hasCommits) {
    return (
      <section className="plan__sec">
        <div className="plan__sec-h">What this change does</div>
        <div className="plan__empty">No description available.</div>
      </section>
    );
  }

  return (
    <>
      {hasClaims && (
        <section className="plan__sec">
          <div className="plan__sec-h">What this change does</div>
          <ul className="plan__claims">
            {intent.map((c, i) => (
              <ClaimRow key={i} claim={c} onNavigate={onNavigate} />
            ))}
          </ul>
        </section>
      )}
      {prBody && (
        <section className="plan__sec">
          <div className="plan__sec-h">PR description</div>
          <div className="plan__desc">
            <MarkdownView
              source={prBody}
              basePath=""
              imageAssets={changeset?.imageAssets}
            />
          </div>
          {changeset && !hasCommits && !hideStaticFiles && (
            <DescriptionFiles changeset={changeset} onNavigate={onNavigate} />
          )}
        </section>
      )}
      {fallbackDescription && (
        <section className="plan__sec">
          <div className="plan__sec-h">What this change does</div>
          <div className="plan__desc">
            <MarkdownView
              source={fallbackDescription}
              basePath=""
              imageAssets={changeset?.imageAssets}
            />
          </div>
          {changeset && !hasCommits && !hideStaticFiles && (
            <DescriptionFiles changeset={changeset} onNavigate={onNavigate} />
          )}
        </section>
      )}
    </>
  );
}

function CommitsSection({
  changeset,
  onNavigate,
  onFilterToCommit,
}: {
  changeset: ChangeSet;
  onNavigate?: (ev: EvidenceRef) => void;
  onFilterToCommit?: (sha: string) => void;
}) {
  return (
    <section className="plan__sec">
      <div className="plan__sec-h">Commits</div>
      <CommitGroups
        changeset={changeset}
        onNavigate={onNavigate}
        onFilterToCommit={onFilterToCommit}
      />
    </section>
  );
}

function useGraphNodes(graph: ChangeSet["graph"]): Map<string, CodeGraphNode> {
  return useMemo(() => {
    const map = new Map<string, CodeGraphNode>();
    for (const n of graph?.nodes ?? []) map.set(n.path, n);
    return map;
  }, [graph]);
}

function FileLine({
  path,
  nodeByPath,
  onNavigate,
}: {
  path: string;
  nodeByPath: Map<string, CodeGraphNode>;
  onNavigate?: (ev: EvidenceRef) => void;
}) {
  const node = nodeByPath.get(path);
  const symbols = node?.symbols ?? [];
  return (
    <li className="plan__desc-file">
      <Reference ev={{ kind: "file", path }} onNavigate={onNavigate} />
      {node && <span className="plan__desc-file-role">{node.fileRole}</span>}
      {symbols.length > 0 && (
        <span className="plan__desc-file-defs">
          defines{" "}
          {symbols.map((s) => (
            <Reference
              key={s.name}
              ev={{ kind: "symbol", name: s.name, definedIn: path }}
              onNavigate={onNavigate}
            />
          ))}
        </span>
      )}
    </li>
  );
}

function DescriptionFiles({
  changeset,
  onNavigate,
}: {
  changeset: ChangeSet;
  onNavigate?: (ev: EvidenceRef) => void;
}) {
  const nodeByPath = useGraphNodes(changeset.graph);
  if (changeset.files.length === 0) return null;
  return (
    <ul className="plan__desc-files">
      {changeset.files.map((f) => (
        <FileLine
          key={f.id}
          path={f.path}
          nodeByPath={nodeByPath}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

function CommitGroups({
  changeset,
  onNavigate,
  onFilterToCommit,
}: {
  changeset: ChangeSet;
  onNavigate?: (ev: EvidenceRef) => void;
  onFilterToCommit?: (sha: string) => void;
}) {
  const nodeByPath = useGraphNodes(changeset.graph);
  const commits = changeset.commits ?? [];
  // Collapse bodies by default once a list has more than one commit — single
  // commits stay inline because there's no clutter to hide.
  const collapsibleBody = commits.length > 1;
  return (
    <ol className="plan__commits">
      {commits.map((c) => (
        <CommitGroup
          key={c.sha}
          commit={c}
          nodeByPath={nodeByPath}
          imageAssets={changeset.imageAssets}
          onNavigate={onNavigate}
          collapsibleBody={collapsibleBody}
          onFilterToCommit={onFilterToCommit}
        />
      ))}
    </ol>
  );
}

function CommitGroup({
  commit,
  nodeByPath,
  imageAssets,
  onNavigate,
  collapsibleBody,
  onFilterToCommit,
}: {
  commit: ChangeSetCommit;
  nodeByPath: Map<string, CodeGraphNode>;
  imageAssets?: Record<string, string>;
  onNavigate?: (ev: EvidenceRef) => void;
  collapsibleBody: boolean;
  onFilterToCommit?: (sha: string) => void;
}) {
  const body = commit.body && (
    <div className="plan__commit-body">
      <MarkdownView
        source={commit.body}
        basePath=""
        imageAssets={imageAssets}
      />
    </div>
  );

  return (
    <li className="plan__commit">
      <div className="plan__commit-h">
        {onFilterToCommit ? (
          <button
            type="button"
            className="plan__commit-sha plan__commit-sha--btn"
            onClick={() => onFilterToCommit(commit.sha)}
            title="Show diff for this commit only"
          >
            {commit.shortSha}
          </button>
        ) : (
          <code className="plan__commit-sha">{commit.shortSha}</code>
        )}
        <span className="plan__commit-subject">{commit.subject}</span>
      </div>
      {commit.body &&
        (collapsibleBody ? (
          <details className="plan__commit-fold">
            <summary className="plan__commit-fold-summary">description</summary>
            {body}
          </details>
        ) : (
          body
        ))}
      {commit.files.length > 0 && (
        <details className="plan__commit-fold">
          <summary className="plan__commit-fold-summary">
            files ({commit.files.length})
          </summary>
          <ul className="plan__desc-files">
            {commit.files.map((p) => (
              <FileLine
                key={p}
                path={p}
                nodeByPath={nodeByPath}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function ClaimRow({
  claim,
  onNavigate,
}: {
  claim: Claim;
  onNavigate?: (ev: EvidenceRef) => void;
}) {
  // Guard: a claim with no evidence should not render. This is a load-bearing
  // invariant — the whole point is that every claim cites something.
  if (claim.evidence.length === 0) return null;
  return (
    <li className="plan__claim">
      <span className="plan__claim-text">{claim.text}</span>
      <span className="plan__claim-cites">
        {claim.evidence.map((e, i) => (
          <Reference key={i} ev={e} onNavigate={onNavigate} />
        ))}
      </span>
    </li>
  );
}

function EntryPointsSection({
  map,
  entryPoints,
  onJumpToEntry,
  onNavigate,
}: {
  map: StructureMap;
  entryPoints: EntryPoint[];
  onJumpToEntry?: (entry: EntryPoint) => void;
  onNavigate?: (ev: EvidenceRef) => void;
}) {
  const ranked = entryPoints.filter((e) => e.reason.evidence.length > 0);
  if (ranked.length === 0) return null;
  return (
    <section className="plan__sec">
      <div className="plan__sec-h">Where to start</div>
      <ol className="plan__files plan__files--priority">
        {ranked.map((entry, i) => {
          const file = map.files.find((x) => x.fileId === entry.fileId);
          return (
            <EntryFileRow
              key={entry.fileId}
              rank={i + 1}
              entry={entry}
              file={file}
              defines={file ? symbolsDefinedIn(map, file.path) : []}
              onJumpToEntry={onJumpToEntry}
              onNavigate={onNavigate}
            />
          );
        })}
      </ol>
    </section>
  );
}

function CollapsedMapSection({
  map,
  entryPoints,
  onNavigate,
  showDiagram,
  onToggleDiagram,
  diagram,
  includeMarkdown,
  onToggleMarkdown,
}: {
  map: StructureMap;
  entryPoints: EntryPoint[];
  onNavigate?: (ev: EvidenceRef) => void;
  showDiagram: boolean;
  onToggleDiagram: () => void;
  diagram: ReturnType<typeof buildPlanDiagram> | null;
  includeMarkdown: boolean;
  onToggleMarkdown: () => void;
}) {
  // The "all files" disclosure shows the rest of the static map below the AI
  // entry points. Ranked entries are already promoted above, so list only the
  // remainder here to avoid duplicates.
  const entryFileIds = new Set(
    entryPoints
      .filter((e) => e.reason.evidence.length > 0)
      .map((e) => e.fileId),
  );
  const otherFiles = map.files.filter((f) => !entryFileIds.has(f.fileId));
  if (otherFiles.length === 0 && !diagram) return null;
  return (
    <section className="plan__sec">
      <details className="plan__allfiles">
        <summary className="plan__allfiles-summary">
          all files ({map.files.length})
        </summary>
        <div className="plan__allfiles-body">
          <div className="plan__sec-head plan__sec-head--inline">
            <button
              type="button"
              className="plan__sec-btn"
              onClick={onToggleDiagram}
            >
              {showDiagram ? "hide diagram" : "generate diagram"}
            </button>
          </div>
          {otherFiles.length > 0 && (
            <ul className="plan__files">
              {otherFiles.map((f) => (
                <FileRow
                  key={f.fileId}
                  file={f}
                  defines={symbolsDefinedIn(map, f.path)}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          )}
          {diagram && (
            <PlanDiagramView
              diagram={diagram}
              includeMarkdown={includeMarkdown}
              onToggleMarkdown={onToggleMarkdown}
              onNavigate={onNavigate}
            />
          )}
        </div>
      </details>
    </section>
  );
}

function MapSection({
  map,
  entryPoints,
  onJumpToEntry,
  onNavigate,
  showDiagram,
  onToggleDiagram,
  diagram,
  includeMarkdown,
  onToggleMarkdown,
}: {
  map: StructureMap;
  entryPoints: EntryPoint[];
  onJumpToEntry?: (entry: EntryPoint) => void;
  onNavigate?: (ev: EvidenceRef) => void;
  showDiagram: boolean;
  onToggleDiagram: () => void;
  diagram: ReturnType<typeof buildPlanDiagram> | null;
  includeMarkdown: boolean;
  onToggleMarkdown: () => void;
}) {
  // Mirror ClaimRow's invariant: a "claim" with no evidence breaches the
  // evidence-mandatory promise. Drop the rank, the file still appears below.
  const rankedEntries = entryPoints.filter(
    (e) => e.reason.evidence.length > 0,
  );
  const entryFileIds = new Set(rankedEntries.map((e) => e.fileId));
  const otherFiles = map.files.filter((f) => !entryFileIds.has(f.fileId));

  return (
    <section className="plan__sec">
      <div className="plan__sec-head">
        <div className="plan__sec-h">Map</div>
        <button
          type="button"
          className="plan__sec-btn"
          onClick={onToggleDiagram}
        >
          {showDiagram ? "hide diagram" : "generate diagram"}
        </button>
      </div>
      {rankedEntries.length === 0 && (
        <div className="plan__empty plan__map-empty">
          No clear entry point — the diff is flat. Review files below in any
          order.
        </div>
      )}
      {rankedEntries.length > 0 && (
        <ol className="plan__files plan__files--priority">
          {rankedEntries.map((entry, i) => {
            const file = map.files.find((x) => x.fileId === entry.fileId);
            return (
              <EntryFileRow
                key={entry.fileId}
                rank={i + 1}
                entry={entry}
                file={file}
                defines={file ? symbolsDefinedIn(map, file.path) : []}
                onJumpToEntry={onJumpToEntry}
                onNavigate={onNavigate}
              />
            );
          })}
        </ol>
      )}
      {rankedEntries.length > 0 && otherFiles.length > 0 && (
        <div className="plan__files-divider">other changes</div>
      )}
      {otherFiles.length > 0 && (
        <ul className="plan__files">
          {otherFiles.map((f) => (
            <FileRow
              key={f.fileId}
              file={f}
              defines={symbolsDefinedIn(map, f.path)}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
      {diagram && (
        <PlanDiagramView
          diagram={diagram}
          includeMarkdown={includeMarkdown}
          onToggleMarkdown={onToggleMarkdown}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}

function symbolsDefinedIn(map: StructureMap, path: string): string[] {
  return map.symbols.filter((s) => s.definedIn === path).map((s) => s.name);
}

function FileRow({
  file,
  defines,
  onNavigate,
}: {
  file: StructureMapFile;
  defines: string[];
  onNavigate?: (ev: EvidenceRef) => void;
}) {
  return (
    <li className="plan__file">
      <span className={`plan__file-status plan__file-status--${file.status}`}>
        {statusGlyph(file.status)}
      </span>
      <Reference
        ev={{ kind: "file", path: file.path }}
        onNavigate={onNavigate}
      />
      <span className="plan__file-counts">
        {file.added > 0 && <span className="plan__add">+{file.added}</span>}
        {file.removed > 0 && <span className="plan__del">−{file.removed}</span>}
      </span>
      {file.isTest && <span className="plan__badge">test</span>}
      {defines.length > 0 && (
        <span className="plan__file-defs">
          defines{" "}
          {defines.map((name) => (
            <Reference
              key={name}
              ev={{ kind: "symbol", name, definedIn: file.path }}
              onNavigate={onNavigate}
            />
          ))}
        </span>
      )}
    </li>
  );
}

function statusGlyph(status: StructureMapFile["status"]): string {
  switch (status) {
    case "added":
      return "+";
    case "deleted":
      return "−";
    case "renamed":
      return "↻";
    case "modified":
    default:
      return "~";
  }
}

function EntryFileRow({
  rank,
  entry,
  file,
  defines,
  onJumpToEntry,
  onNavigate,
}: {
  rank: number;
  entry: EntryPoint;
  file: StructureMapFile | undefined;
  defines: string[];
  onJumpToEntry?: (entry: EntryPoint) => void;
  onNavigate?: (ev: EvidenceRef) => void;
}) {
  return (
    <li className="plan__file plan__file--entry">
      <span className="plan__entry-rank" aria-hidden="true">
        {rank}
      </span>
      {file && (
        <span className={`plan__file-status plan__file-status--${file.status}`}>
          {statusGlyph(file.status)}
        </span>
      )}
      <button
        type="button"
        className="plan__file-jump"
        onClick={onJumpToEntry ? () => onJumpToEntry(entry) : undefined}
        disabled={!onJumpToEntry}
      >
        {file?.path ?? entry.fileId}
      </button>
      {file && (
        <>
          <span className="plan__file-counts">
            {file.added > 0 && <span className="plan__add">+{file.added}</span>}
            {file.removed > 0 && (
              <span className="plan__del">−{file.removed}</span>
            )}
          </span>
          {file.isTest && <span className="plan__badge">test</span>}
          {defines.length > 0 && (
            <span className="plan__file-defs">
              defines{" "}
              {defines.map((name) => (
                <Reference
                  key={name}
                  ev={{ kind: "symbol", name, definedIn: file.path }}
                  onNavigate={onNavigate}
                />
              ))}
            </span>
          )}
        </>
      )}
      <div className="plan__entry-reason">
        <span className="plan__claim-text">{entry.reason.text}</span>
        <span className="plan__claim-cites">
          {entry.reason.evidence.map((ev, j) => (
            <Reference key={j} ev={ev} onNavigate={onNavigate} />
          ))}
        </span>
      </div>
    </li>
  );
}
