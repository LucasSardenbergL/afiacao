/**
 * @deprecated Wrapper de compatibilidade — delega para Sonner.
 *
 * O sistema antigo (Radix toaster) foi descontinuado em favor de Sonner (uma fonte
 * só de feedback). Este wrapper preserva a API antiga (`useToast()` + `toast({title, description, variant})`)
 * para que os callsites existentes continuem funcionando sem refactor imediato.
 *
 * **Não usar em código novo.** Use `import { toast } from 'sonner'` direto:
 *   - `toast.success(title, { description })` em vez de `toast({ title, description })`
 *   - `toast.error(title, { description })` em vez de `toast({ title, variant: 'destructive', description })`
 *
 * Engines IA já migrados: useBundleEngine, useTacticalPlan, useFarmerExperiments, useFarmerPerformance.
 * Migração dos ~100 callsites restantes pode ser feita gradualmente quando os arquivos forem tocados.
 */
import { toast as sonnerToast } from 'sonner';
import type { ReactNode } from 'react';

type LegacyVariant = 'default' | 'destructive';

interface LegacyToastOptions {
  title?: ReactNode;
  description?: ReactNode;
  variant?: LegacyVariant;
  /** Não suportado em Sonner — preservado por compat, mas ignorado */
  action?: unknown;
  duration?: number;
}

interface LegacyToastReturn {
  id: string | number;
  dismiss: () => void;
  update: (opts: LegacyToastOptions) => void;
}

function toReactNodeString(value: ReactNode): string | undefined {
  if (value == null || typeof value === 'boolean') return undefined;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  // ReactNode complexo — Sonner aceita ReactNode, então retornamos como qualquer
  return value as unknown as string;
}

function toast(opts: LegacyToastOptions | string): LegacyToastReturn {
  const normalized: LegacyToastOptions =
    typeof opts === 'string' ? { title: opts } : opts;

  const title = toReactNodeString(normalized.title) ?? '';
  const description = toReactNodeString(normalized.description);
  const variant = normalized.variant ?? 'default';
  const duration = normalized.duration;

  const id =
    variant === 'destructive'
      ? sonnerToast.error(title, { description, duration })
      : sonnerToast(title, { description, duration });

  return {
    id,
    dismiss: () => sonnerToast.dismiss(id),
    update: (next) => {
      sonnerToast.dismiss(id);
      toast(next);
    },
  };
}

function useToast() {
  return {
    toast,
    dismiss: (toastId?: string | number) => sonnerToast.dismiss(toastId),
    toasts: [] as never[],
  };
}

export { useToast, toast };
