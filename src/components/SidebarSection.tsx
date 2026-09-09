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
      {!collapsed && <div className="sidebar-section-body">{children}</div>}
    </div>
  );
}

export default SidebarSection;
