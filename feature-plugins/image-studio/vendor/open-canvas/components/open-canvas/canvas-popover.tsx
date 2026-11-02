"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type PopoverAnchor = HTMLElement | { x: number; y: number };

export function CanvasPopover({ anchor, above = false, className = "", label, role = "menu", children, onClose }: {
  anchor: PopoverAnchor; above?: boolean; className?: string; label: string;
  role?: "menu" | "dialog"; children: ReactNode; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const id = useId();
  useLayoutEffect(() => { close.current = onClose; });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previousFocus = document.activeElement;
    const place = () => {
      const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      element.style.maxHeight = `${Math.max(80, height - 24)}px`;
      element.style.maxWidth = `${Math.max(160, width - 24)}px`;
      const box = element.getBoundingClientRect();
      const x = anchor instanceof HTMLElement ? rect.left + rect.width / 2 - box.width / 2 : above ? rect.left - box.width / 2 : rect.left;
      const preferredY = above ? rect.top - box.height - 10 : rect.bottom + 8;
      const alternateY = above ? rect.bottom + 8 : rect.top - box.height - 8;
      const y = preferredY >= top + 12 && preferredY + box.height <= top + height - 12 ? preferredY : alternateY;
      element.style.left = `${Math.max(left + 12, Math.min(x, left + width - box.width - 12))}px`;
      element.style.top = `${Math.max(top + 12, Math.min(y, top + height - box.height - 12))}px`;
      element.style.visibility = "visible";
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!element.contains(target) && !(anchor instanceof HTMLElement && anchor.contains(target))) close.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const modal = document.querySelector('[data-slot="dialog-content"][data-state="open"]');
      if (modal && !(anchor instanceof HTMLElement && modal.contains(anchor))) return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
    const keys = (event: KeyboardEvent) => {
      if (role !== "menu" || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if ((event.target as HTMLElement)?.matches("input,textarea,select")) return;
      const items = [...element.querySelectorAll<HTMLButtonElement>('button:not(:disabled),[role="menuitem"]:not([aria-disabled="true"])')];
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
    };
    const exclusive = (event: Event) => { if ((event as CustomEvent).detail !== id) close.current(); };
    window.dispatchEvent(new CustomEvent("modmind-canvas-popover", { detail: id }));
    window.addEventListener("modmind-canvas-popover", exclusive);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    element.addEventListener("keydown", keys);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    const observer = new ResizeObserver(place); observer.observe(element);
    if (anchor instanceof HTMLElement) observer.observe(anchor);
    place();
    element.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("modmind-canvas-popover", exclusive);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      element.removeEventListener("keydown", keys);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [anchor, above, id, role]);
  return createPortal(<div ref={ref} tabIndex={-1} role={role} aria-label={label} className={`image-canvas-scope oc-popover nodrag nopan nowheel ${className}`} style={{ visibility: "hidden" }} onPointerDown={event => event.stopPropagation()}>{children}</div>, document.body);
}
