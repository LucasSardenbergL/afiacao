import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Registry global de comandos exibidos na CommandPalette (Cmd+K).
 *
 * Há dois tipos de comandos:
 *  1. **Estáticos**: rotas e ações fixas (ex: "Ir para Cockpit", "Novo pedido"). Registrados pelo AppShell.
 *  2. **Contribuídos por página**: páginas específicas declaram via `useRegisterCommands(...)`.
 *
 * V1 simples: lista plana, busca via filtro fuzzy básico (lowercase substring + tokens).
 * V2 (futuro): integração com Supabase pra busca em registros (clientes, fórmulas, pedidos).
 */
export interface Command {
  /** ID único — recomendado: `area.action` (ex: `nav.cockpit-reposicao`). */
  id: string;
  label: string;
  /** Aliases de busca (ex: ["compras", "comprador", "reposicao"]). */
  keywords?: string[];
  /** Grupo no palette. Ex: "Navegar", "Ações", "Recentes". */
  group?: string;
  icon?: LucideIcon;
  /** Texto curto à direita (ex: "⌘K", "Cockpit"). */
  hint?: string;
  /** Executa o comando. Recebe `close()` para o palette se fechar manualmente se quiser. */
  perform: (close: () => void) => void;
}

interface RegistryContext {
  open: boolean;
  setOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  commands: ReadonlyArray<Command>;
  register: (cmds: Command[]) => () => void;
}

const Ctx = createContext<RegistryContext | null>(null);

export function CommandsRegistryProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [dynamic, setDynamic] = useState<Command[]>([]);

  const register = useCallback((cmds: Command[]) => {
    setDynamic((prev) => [...prev, ...cmds]);
    return () => {
      setDynamic((prev) => prev.filter((c) => !cmds.some((x) => x.id === c.id)));
    };
  }, []);

  const value = useMemo(
    () => ({ open, setOpen, register, commands: dynamic }),
    [open, register, dynamic],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCommandsRegistry(): RegistryContext {
  const ctx = useContext(Ctx);
  if (!ctx) {
    return {
      open: false,
      setOpen: () => undefined,
      commands: [],
      register: () => () => undefined,
    };
  }
  return ctx;
}

/** Páginas declaram comandos contextuais. Memoize o array! */
export function useRegisterCommands(commands: Command[]): void {
  const { register } = useCommandsRegistry();
  useEffect(() => {
    if (commands.length === 0) return;
    return register(commands);
  }, [register, commands]);
}
