import { useRef, type ChangeEvent, type UIEvent } from 'react';
import { highlightYaml } from './yaml-highlight.ts';

interface Props {
  value: string;
  onChange: (next: string) => void;
  language: 'yaml' | 'json';
  className?: string;
  /** Pin a fixed height. Default: 100% of parent. */
  style?: React.CSSProperties;
}

/**
 * Lightweight textarea-with-syntax-highlighting editor. A transparent
 * `<textarea>` sits on top of a highlighted `<pre>`; their scroll
 * positions stay synced via an onScroll handler. The textarea keeps
 * native ergonomics (selection, undo, drag-select, find-on-page,
 * spellcheck off) while the user sees colour underneath.
 *
 * Zero deps — pulls the highlighter from yaml-highlight.ts. Same
 * pattern works for JSON via a minimal regex set if we ever want it;
 * for now `language: 'json'` falls back to no highlighting so the Raw
 * Config view still gets the editor scaffold.
 */
export function CodeEditor({ value, onChange, language, className, style }: Props): JSX.Element {
  const preRef = useRef<HTMLPreElement | null>(null);
  const onScroll = (e: UIEvent<HTMLTextAreaElement>): void => {
    const t = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = t.scrollTop;
      preRef.current.scrollLeft = t.scrollLeft;
    }
  };
  const html =
    language === 'yaml'
      ? highlightYaml(value)
      // Cheap fallback: just escape so the pre still mirrors the
      // textarea content (for future highlighter additions).
      : value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
  return (
    <div className={`code-editor ${className ?? ''}`} style={style}>
      <pre
        ref={preRef}
        className="code-editor__highlight"
        aria-hidden
        // The trailing newline is important: it ensures the highlighter
        // tracks an open last line as the user types past the bottom.
        dangerouslySetInnerHTML={{ __html: `${html}\n` }}
      />
      <textarea
        className="code-editor__input"
        value={value}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        onScroll={onScroll}
        spellCheck={false}
      />
    </div>
  );
}
