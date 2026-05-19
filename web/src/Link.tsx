import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { navigate } from './router.ts';

/** Anchor that triggers client-side nav instead of a full page load. */
export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>): JSX.Element {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
