import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface SidebarSectionProps {
  title: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  actions?: ReactNode;
  children: ReactNode;
  /** Whether this section flex-grows to fill whatever space its sibling sections don't need
   * (the default — right for a section whose content can be arbitrarily long, like the file
   * explorer). Pass `false` for a section that should instead size itself to its own content (up to
   * a cap, scrolling internally beyond that) and let sibling `grow` sections give way to it, rather
   * than competing with them for an equal flex share — see the "Conexões" section in
   * ConnectionsPanel, which used to fight the explorer for 50% of the sidebar even with only a
   * handful of connections in it. */
  grow?: boolean;
}

function SidebarSection({
  title,
  collapsed,
  onToggleCollapsed,
  actions,
  children,
  grow = true,
}: SidebarSectionProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState(0);

  // Fixed-size sections (Specs, Conexões) live in auto-sized rows, so the 1fr/0fr grid-row trick
  // in style.css can't animate their collapse (the row track is content-based, not definite — the
  // delayed `height: 0` fallback would snap instead of easing). Measure the body's full content
  // height and drive a real `height` transition on the collapse wrapper instead; the ResizeObserver
  // (plus re-measuring whenever children/collapsed change) keeps the number in sync as content
  // grows or shrinks, even across window/font resizes.
  useLayoutEffect(() => {
    if (grow) return;
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setContentHeight(el.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [grow, collapsed, children]);

  const collapseStyle = grow ? undefined : { height: collapsed ? 0 : contentHeight || undefined };

  return (
    <div className={`sidebar-section${collapsed ? " collapsed" : ""}${grow ? "" : " fixed-size"}`}>
      <div className="sidebar-section-header" onClick={onToggleCollapsed}>
        <span className="sidebar-chevron">▾</span>
        <span className="sidebar-section-title">{title}</span>
        {actions && (
          <div className="sidebar-section-actions" onClick={(event) => event.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      {/* Kept mounted even when collapsed so the collapse/expand can animate (see
          .sidebar-section-collapse in style.css — a 1fr/0fr grid-row transition); unmounting the
          body would make it snap instead of easing. */ }
      <div className="sidebar-section-collapse" style={collapseStyle}>
        <div className="sidebar-section-body" ref={bodyRef}>{children}</div>
      </div>
    </div>
  );
}

export default SidebarSection;
