import { useEffect, useState } from "react";

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  checked?: boolean;
  disabled?: boolean;
  shortcut?: string;
  submenu?: MenuItem[];
}

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

interface MenuBarProps {
  menus: MenuDef[];
}

function MenuBar({ menus }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [openMenu]);

  return (
    <div className="menu-bar" onClick={(event) => event.stopPropagation()}>
      {menus.map((menu) => (
        <div key={menu.label} className="menu-bar-item">
          <button
            type="button"
            className={`menu-bar-label${openMenu === menu.label ? " open" : ""}`}
            onClick={() => setOpenMenu((current) => (current === menu.label ? null : menu.label))}
            onMouseEnter={() => setOpenMenu((current) => (current ? menu.label : current))}
          >
            {menu.label}
          </button>
          {openMenu === menu.label && (
            <ul className="menu-dropdown">
              {menu.items.map((item) => (
                <MenuItemRow key={item.label} item={item} onDone={() => setOpenMenu(null)} />
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function MenuItemRow({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const [submenuOpen, setSubmenuOpen] = useState(false);

  return (
    <li
      className={`menu-item${item.disabled ? " disabled" : ""}`}
      onMouseEnter={() => item.submenu && setSubmenuOpen(true)}
      onMouseLeave={() => item.submenu && setSubmenuOpen(false)}
      onClick={() => {
        if (item.disabled || item.submenu) return;
        item.onSelect?.();
        onDone();
      }}
    >
      <span className="menu-item-check">{item.checked ? "✓" : ""}</span>
      <span className="menu-item-label">{item.label}</span>
      {item.shortcut && <span className="menu-item-shortcut">{item.shortcut}</span>}
      {item.submenu && <span className="menu-item-arrow">▸</span>}
      {item.submenu && submenuOpen && (
        <ul className="menu-dropdown menu-submenu">
          {item.submenu.map((sub) => (
            <MenuItemRow key={sub.label} item={sub} onDone={onDone} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default MenuBar;
