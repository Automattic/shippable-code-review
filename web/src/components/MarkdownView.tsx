import "./MarkdownView.css";
import githubMarkdownLightCss from "github-markdown-css/github-markdown-light.css?raw";
import githubMarkdownDarkCss from "github-markdown-css/github-markdown-dark.css?raw";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import mermaid from "mermaid";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkAlert } from "remark-github-blockquote-alert";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import { highlightCode } from "../highlight";
import {
  ensureMermaidReadyForUntrustedMarkdown,
  stripMermaidClickDirectives,
} from "./mermaidClient";
import { MediaLightbox } from "./MediaLightbox";
import {
  resolveImageSrc,
  resolvePath,
  type ResolvedImageSource,
} from "./resolveImageSrc";

// Inject scoped GitHub markdown styles once on first import. The standalone
// -light/-dark stylesheets target `.markdown-body`; rescope each under
// `[data-color-scheme=…] .markdown-body` so the variant follows the app's
// theme. `data-color-scheme` lives on <html> and is kept up-to-date by the
// global theme code, so swapping themes auto-toggles the preview without
// MarkdownView holding its own theme state.
if (typeof document !== "undefined" && !document.getElementById("gh-md-scoped")) {
  const style = document.createElement("style");
  style.id = "gh-md-scoped";
  const scope = (css: string, scheme: "light" | "dark") =>
    css.replace(/\.markdown-body/g, `[data-color-scheme="${scheme}"] .markdown-body`);
  style.textContent = `${scope(githubMarkdownLightCss, "light")}\n${scope(githubMarkdownDarkCss, "dark")}`;
  document.head.appendChild(style);
}

interface Props {
  /** Raw markdown source. */
  source: string;
  /**
   * Path of the file being rendered, used as the base for resolving relative
   * image and link references (e.g. `docs/features/prompt-results.md`).
   */
  basePath: string;
  /**
   * Map from repo-relative file path to a data URL (or any URL the browser
   * can load). MarkdownView resolves relative image references against this
   * map; only references that resolve through this map auto-load.
   */
  imageAssets?: Record<string, string>;
}

export function MarkdownView({ source, basePath, imageAssets }: Props) {
  const baseDir = useMemo(() => dirname(basePath), [basePath]);

  return (
    <section className="md-preview">
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkAlert]}
          rehypePlugins={[
            rehypeSlug,
            [rehypeAutolinkHeadings, { behavior: "wrap" }],
          ]}
          components={{
            code: CodeBlock,
            img: (props) => <ResolvedImg {...props} baseDir={baseDir} imageAssets={imageAssets} />,
            a: (props) => <ResolvedLink {...props} baseDir={baseDir} />,
          }}
        >
          {source}
        </ReactMarkdown>
      </div>
    </section>
  );
}

function CodeBlock({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLElement>) {
  const text = String(children ?? "").replace(/\n$/, "");
  // react-markdown emits inline code as `code` without a `language-*` class.
  // Block code arrives as `<pre><code class="language-x">…</code></pre>`.
  const match = /language-([\w-]+)/.exec(className ?? "");

  if (!match) {
    return <code className={className} {...rest}>{children}</code>;
  }

  if (match[1] === "mermaid") {
    return <MermaidBlock source={text} />;
  }

  return <ShikiBlock code={text} language={match[1]} />;
}

function MermaidBlock({ source }: { source: string }) {
  const renderId = useId().replace(/[:]/g, "_");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    ensureMermaidReadyForUntrustedMarkdown();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const target = containerRef.current;
    if (!target) return;
    setError(null);
    // Reapply strict config right before render. PlanDiagramView shares the
    // same mermaid singleton and reinitialises it to "loose" for its own use;
    // if its render interleaves with ours, strict mode here keeps
    // attacker-controlled markdown from emitting `javascript:` URLs.
    // stripMermaidClickDirectives is the matching source-level defense and
    // holds even if the global config flips.
    ensureMermaidReadyForUntrustedMarkdown();
    mermaid
      .render(`md-mermaid-${renderId}`, stripMermaidClickDirectives(source))
      .then((result) => {
        if (cancelled || !target) return;
        target.innerHTML = result.svg;
        if (result.bindFunctions) result.bindFunctions(target);
        setSvg(result.svg);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [source, renderId]);

  if (error) {
    return (
      <div className="md-preview__mermaid-error">
        <p>Couldn't render Mermaid diagram:</p>
        <pre>{error}</pre>
        <details>
          <summary>Source</summary>
          <pre><code>{source}</code></pre>
        </details>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="md-preview__mermaid md-preview__zoomable"
        title="Click to zoom"
        onClick={() => svg && setZoomed(true)}
        disabled={!svg}
      >
        <span ref={containerRef} className="md-preview__mermaid-svg" aria-label="Mermaid diagram" />
      </button>
      {zoomed && svg ? (
        <MediaLightbox content={{ kind: "svg", svg }} onClose={() => setZoomed(false)} />
      ) : null}
    </>
  );
}

function ShikiBlock({ code, language }: { code: string; language: string }) {
  const [node, setNode] = useState<ReactNode>(null);

  useEffect(() => {
    let cancelled = false;
    void highlightCode(code, language).then((result) => {
      if (!cancelled) setNode(result.node);
    });
    return () => { cancelled = true; };
  }, [code, language]);

  if (node) {
    return <span className="md-preview__shiki">{node}</span>;
  }
  return (
    <pre className="md-preview__code-fallback">
      <code>{code}</code>
    </pre>
  );
}

export function ResolvedImg({
  src,
  alt,
  className,
  baseDir,
  imageAssets,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement> & {
  baseDir: string;
  imageAssets?: Record<string, string>;
}) {
  const resolved = useMemo(
    () => resolveImageSrc(src, baseDir, imageAssets),
    [src, baseDir, imageAssets],
  );

  if (!resolved) return null;

  if (resolved.kind === "local") {
    return <ZoomableImage src={resolved.src} alt={alt ?? ""} className={className} {...rest} />;
  }

  // Key the gate on the resolved identity so React unmounts/remounts (and
  // resets isEnabled) when the source changes — no setState-in-effect needed.
  const key = resolved.kind === "blocked" ? resolved.src : resolved.resolvedPath;
  return (
    <ResolvedImgGate
      key={key}
      resolved={resolved}
      alt={alt}
      className={className}
      {...rest}
    />
  );
}

function ZoomableImage({
  src,
  alt,
  className,
  title,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt ?? ""}
        className={cx("md-preview__zoomable-img", className)}
        {...rest}
        title={title ?? "Click to zoom"}
        onClick={() => setZoomed(true)}
      />
      {zoomed ? (
        <MediaLightbox
          content={{ kind: "image", src, alt: alt ?? undefined }}
          onClose={() => setZoomed(false)}
        />
      ) : null}
    </>
  );
}

function ResolvedImgGate({
  resolved,
  alt,
  className,
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement> & {
  resolved: Exclude<ResolvedImageSource, { kind: "local" }>;
}) {
  const [isEnabled, setIsEnabled] = useState(false);

  if (resolved.kind === "blocked" && isEnabled) {
    return <ZoomableImage src={resolved.src} alt={alt ?? ""} className={className} {...rest} />;
  }

  return (
    <span
      className={cx("md-preview__img-gate", className)}
      role="group"
      aria-label={alt ?? "Markdown image"}
      title={resolved.kind === "blocked" ? resolved.src : resolved.resolvedPath}
    >
      <span className="md-preview__img-gate-copy">
        <span className="md-preview__img-gate-title">
          {resolved.kind === "blocked" ? "Image blocked" : "Repo image unavailable"}
        </span>
        <span className="md-preview__img-gate-meta">
          {resolved.kind === "blocked"
            ? formatBlockedImageSrc(resolved.src)
            : resolved.resolvedPath}
        </span>
      </span>
      {resolved.kind === "blocked" ? (
        <button
          type="button"
          className="md-preview__img-gate-btn"
          onClick={() => setIsEnabled(true)}
        >
          Load image
        </button>
      ) : null}
    </span>
  );
}

function ResolvedLink({
  href,
  children,
  baseDir,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { baseDir: string }) {
  const isAbsolute = href ? /^(?:[a-z]+:|\/\/|#)/i.test(href) : false;
  if (!href || isAbsolute) {
    return <a href={href} {...rest}>{children}</a>;
  }
  // Relative link inside the repo. We don't have anywhere to navigate to, so
  // surface the resolved repo path as a tooltip and disable the link.
  const resolved = resolvePath(baseDir, href);
  return (
    <a
      href={`#${resolved}`}
      title={resolved}
      onClick={(e) => e.preventDefault()}
      {...rest}
    >
      {children}
    </a>
  );
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function formatBlockedImageSrc(src: string): string {
  if (/^data:/i.test(src)) return "inline data URL";
  return src.length > 96 ? `${src.slice(0, 93)}...` : src;
}

function cx(...parts: Array<string | undefined>): string | undefined {
  const value = parts.filter(Boolean).join(" ");
  return value || undefined;
}
