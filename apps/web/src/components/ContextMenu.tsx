"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type MenuItem = {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

type Props = {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export function ContextMenu({ open, x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          className="context-menu"
          style={{ left: x, top: y }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.12 }}
          role="menu"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`context-item ${item.danger ? "danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                onClose();
              }}
            >
              {item.label}
            </button>
          ))}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function useNativeContextBlock(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, [enabled]);
}

export function ContextSurface({
  children,
  items,
  className,
}: {
  children: ReactNode;
  items: MenuItem[];
  className?: string;
}) {
  const [menu, setMenu] = useState({ open: false, x: 0, y: 0 });

  return (
    <div
      className={className}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ open: true, x: e.clientX, y: e.clientY });
      }}
    >
      {children}
      <ContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={items}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />
    </div>
  );
}
