import { useEffect } from "react";

export type ShortcutMap = Record<string, (e: KeyboardEvent) => void>;

/**
 * Hook simples de atalhos de teclado.
 * - Ignora eventos quando o foco está em input/textarea/select/[contenteditable].
 * - Chaves são lowercase (ex: "g", "e", "1", "?").
 */
export function useKeyboardShortcuts(map: ShortcutMap, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      const fn = map[key];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [map, enabled]);
}
