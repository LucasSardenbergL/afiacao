import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { track } from '@/lib/analytics';

/**
 * Registry global de atalhos. Páginas declaram via `useRegisterShortcuts(...)`.
 * O AppShell monta o `<ShortcutsRegistryProvider />` e o `<ShortcutsDialog />`.
 *
 * Composição de tecla: lower-case, modifiers em ordem `mod+shift+key`
 *  - "g" → tecla "g" sem modifier
 *  - "mod+k" → Cmd no Mac, Ctrl no resto
 *  - "shift+/" → "?"
 *
 * Escopo:
 *  - "global" → ativo em qualquer rota (cuidado: deve ser raro)
 *  - "page" → ativo enquanto o componente que registrou estiver montado (default)
 *
 * Bloqueio: handler NÃO dispara em input/textarea/[contenteditable] (evita conflito com digitação).
 */
type ShortcutScope = 'global' | 'page';

export interface Shortcut {
  /** Tecla composta. Ex: "g", "mod+k", "shift+/". */
  keys: string;
  /** Texto curto exibido no dialog. Ex: "Gerar pedidos do dia". */
  label: string;
  /** Grupo no dialog. Ex: "Cockpit", "Navegação". */
  group?: string;
  scope?: ShortcutScope;
  handler: (e: KeyboardEvent) => void;
  /** Permite atalho mesmo em campo de input (use com parcimônia). */
  allowInInput?: boolean;
}

interface RegistryEntry extends Shortcut {
  id: number;
}

interface RegistryContext {
  register: (shortcut: Shortcut) => () => void;
  shortcuts: ReadonlyArray<RegistryEntry>;
}

const Ctx = createContext<RegistryContext | null>(null);

let nextId = 1;

function isMac() {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

function eventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  // Normaliza "?" (vem como "Shift+/")
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'escape') key = 'esc';
  parts.push(key);
  return parts.join('+');
}

function isFromInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function ShortcutsRegistryProvider({ children }: { children: ReactNode }) {
  const [shortcuts, setShortcuts] = useState<RegistryEntry[]>([]);
  const ref = useRef<RegistryEntry[]>([]);
  ref.current = shortcuts;

  const register = useCallback((shortcut: Shortcut) => {
    const id = nextId++;
    const entry: RegistryEntry = { id, scope: 'page', ...shortcut };
    setShortcuts((prev) => [...prev, entry]);
    return () => setShortcuts((prev) => prev.filter((s) => s.id !== id));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const combo = eventToCombo(e);
      const fromInput = isFromInput(e.target);
      // primeiro: atalhos exatos com modifier (cmd/ctrl) ou shift devem disparar em qualquer lugar
      // (a heurística: se tem modifier, é uma combinação intencional, não conflita com digitação)
      const hasMod = e.metaKey || e.ctrlKey || e.altKey;
      for (const s of ref.current) {
        if (s.keys.toLowerCase() === combo) {
          if (fromInput && !s.allowInInput && !hasMod) continue;
          e.preventDefault();
          // Telemetria: rastreia uso real de atalhos pra validar adoção
          track('shortcut.triggered', {
            keys: s.keys,
            label: s.label,
            group: s.group ?? null,
          });
          s.handler(e);
          return;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const value = useMemo(() => ({ register, shortcuts }), [register, shortcuts]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useShortcutsRegistry(): RegistryContext {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Fallback no-op para componentes que rodam fora do provider (ex: testes isolados)
    return { register: () => () => undefined, shortcuts: [] };
  }
  return ctx;
}

/**
 * Hook para páginas declararem atalhos.
 *
 *   useRegisterShortcuts([
 *     { keys: 'g', label: 'Gerar', group: 'Cockpit', handler: () => handleGenerate() },
 *     { keys: 'r', label: 'Atualizar', group: 'Cockpit', handler: () => refetch() },
 *     { keys: 'mod+k', label: 'Buscar', group: 'Global', handler: () => openPalette() },
 *   ]);
 *
 * Re-registra se `shortcuts` mudar de identidade — passe array memoizado se necessário.
 */
export function useRegisterShortcuts(shortcuts: Shortcut[]): void {
  const { register } = useShortcutsRegistry();
  useEffect(() => {
    const offs = shortcuts.map((s) => register(s));
    return () => offs.forEach((off) => off());
  }, [register, shortcuts]);
}

/** Util para exibir combo no dialog ("⌘K" no Mac, "Ctrl+K" no resto). */
export function formatCombo(keys: string): string {
  const mac = isMac();
  return keys
    .split('+')
    .map((k) => {
      if (k === 'mod') return mac ? '⌘' : 'Ctrl';
      if (k === 'shift') return mac ? '⇧' : 'Shift';
      if (k === 'alt') return mac ? '⌥' : 'Alt';
      if (k === 'esc') return 'Esc';
      if (k === 'space') return 'Espaço';
      if (k.length === 1) return k.toUpperCase();
      return k.charAt(0).toUpperCase() + k.slice(1);
    })
    .join(mac ? ' ' : '+');
}
