'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

// docs/design/reception-console.md "Tablet". Mirrors the CSS media query that
// restyles the console, so the side panel becomes a modal dialog only where
// the CSS shows it as one.
export const TABLET_QUERY = '(max-width: 1199px) and (pointer: coarse)';

export function useTabletMode(): boolean {
  const [tablet, setTablet] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(TABLET_QUERY);
    const sync = () => setTablet(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return tablet;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Keeps Tab inside the panel; pure so it can be unit tested.
export function nextTrapIndex(
  count: number,
  current: number,
  backwards: boolean,
): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? count - 1 : 1)) % count;
}

export function SidePanelShell({
  label,
  openLabel,
  closeLabel,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  openLabel: string;
  closeLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const tablet = useTabletMode();
  const panelRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const modal = tablet && open;

  useEffect(() => {
    if (modal) {
      wasOpen.current = true;
      const first = panelRef.current?.querySelector<HTMLElement>(
        'input:not([type="hidden"])',
      );
      (first ?? panelRef.current)?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      openerRef.current?.focus();
    }
  }, [modal]);

  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (!modal) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      return onOpenChange(false);
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = nextTrapIndex(items.length, at, event.shiftKey);
    if (next < 0) return;
    // Only intercept at the edges; Tab inside the panel moves normally.
    const edge = event.shiftKey ? at <= 0 : at === items.length - 1;
    if (edge || at < 0) {
      event.preventDefault();
      items[next]?.focus();
    }
  }

  return (
    <>
      {tablet && (
        <button
          ref={openerRef}
          type="button"
          className="tabletAddButton"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => onOpenChange(true)}
        >
          {openLabel}
        </button>
      )}
      {modal && (
        <div
          className="tabletBackdrop"
          data-testid="tablet-backdrop"
          onClick={() => onOpenChange(false)}
        />
      )}
      <aside
        ref={panelRef}
        className={`consoleSide${tablet ? ' tabletPanel' : ''}`}
        aria-label={label}
        role={modal ? 'dialog' : undefined}
        aria-modal={modal ? true : undefined}
        hidden={tablet && !open}
        tabIndex={modal ? -1 : undefined}
        onKeyDown={onKeyDown}
      >
        {tablet && (
          <button
            type="button"
            className="tabletClose"
            onClick={() => onOpenChange(false)}
          >
            {closeLabel}
          </button>
        )}
        {children}
      </aside>
    </>
  );
}
