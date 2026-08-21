import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for chat bubbles, sized for the assistant window's text-xs
 * scale. Loaded lazily from `BoardAssistant` so the board's initial bundle does
 * not pay for it — see the `Suspense` fallback there, which shows the raw text.
 *
 * `tone` picks a palette: "user" renders on the indigo bubble (light text),
 * "agent" on the grey/white ones (dark text).
 */
export default function ChatMarkdown({
  text,
  tone,
}: {
  text: string;
  tone: "user" | "agent";
}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS[tone]}>
      {text}
    </ReactMarkdown>
  );
}

/** Styles shared by both tones; only link/code colours differ. */
function componentsFor(tone: "user" | "agent"): Components {
  const dark = tone === "user";
  return {
    p: ({ children }) => <p className="[&:not(:first-child)]:mt-1.5">{children}</p>,
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={`underline underline-offset-2 break-all ${
          dark ? "decoration-white/60" : "text-indigo-600 decoration-indigo-300"
        }`}
      >
        {children}
      </a>
    ),
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    ul: ({ children }) => (
      <ul className="list-disc pl-4 [&:not(:first-child)]:mt-1">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-4 [&:not(:first-child)]:mt-1">{children}</ol>
    ),
    li: ({ children }) => <li className="mt-0.5">{children}</li>,
    code: ({ children }) => (
      <code
        className={`rounded px-1 font-mono text-[11px] ${
          dark ? "bg-white/20" : "bg-slate-200/70 text-slate-800"
        }`}
      >
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="overflow-x-auto rounded-md bg-slate-800 p-2 text-[10px] leading-snug text-slate-100 [&:not(:first-child)]:mt-1 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
        {children}
      </pre>
    ),
    blockquote: ({ children }) => (
      <blockquote
        className={`border-l-2 pl-2 [&:not(:first-child)]:mt-1 ${
          dark ? "border-white/40 text-white/80" : "border-slate-300 text-slate-500"
        }`}
      >
        {children}
      </blockquote>
    ),
    h1: Heading,
    h2: Heading,
    h3: Heading,
    h4: Heading,
    hr: () => <hr className={`my-1.5 ${dark ? "border-white/30" : "border-slate-200"}`} />,
    table: ({ children }) => (
      <div className="overflow-x-auto [&:not(:first-child)]:mt-1">
        <table className="border-collapse text-[11px]">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th
        className={`border px-1.5 py-0.5 text-left font-semibold ${
          dark ? "border-white/30" : "border-slate-200 bg-slate-50"
        }`}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className={`border px-1.5 py-0.5 ${dark ? "border-white/30" : "border-slate-200"}`}>
        {children}
      </td>
    ),
  };
}

/** Headings all render the same: chat bubbles have no room for a type scale. */
function Heading({ children }: { children?: React.ReactNode }) {
  return (
    <p className="font-semibold [&:not(:first-child)]:mt-1.5">{children}</p>
  );
}

const COMPONENTS: Record<"user" | "agent", Components> = {
  user: componentsFor("user"),
  agent: componentsFor("agent"),
};
