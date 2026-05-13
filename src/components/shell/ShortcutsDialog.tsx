import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useShortcutsRegistry, formatCombo, useRegisterShortcuts } from './ShortcutsRegistry';

export function ShortcutsDialog() {
  const { shortcuts } = useShortcutsRegistry();
  const [open, setOpen] = useState(false);

  useRegisterShortcuts(
    useMemo(
      () => [
        {
          keys: 'shift+/',
          label: 'Mostrar atalhos',
          group: 'Global',
          scope: 'global',
          handler: () => setOpen((v) => !v),
        },
        {
          keys: '?',
          label: 'Mostrar atalhos',
          group: 'Global',
          scope: 'global',
          handler: () => setOpen((v) => !v),
        },
      ],
      [],
    ),
  );

  // Esc fecha o dialog (Radix já trata, mas garantimos parando propagação)
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [open]);

  // Permite abrir programaticamente via custom event (botões em páginas que querem o affordance visual).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('open-shortcuts-dialog', onOpen);
    return () => window.removeEventListener('open-shortcuts-dialog', onOpen);
  }, []);

  const grouped = useMemo(() => {
    type Entry = (typeof shortcuts)[number];
    const map = new Map<string, Entry[]>();
    for (const s of shortcuts) {
      const key = s.group ?? (s.scope === 'global' ? 'Global' : 'Esta página');
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === 'Global') return -1;
      if (b === 'Global') return 1;
      if (a === 'Esta página') return 1;
      if (b === 'Esta página') return -1;
      return a.localeCompare(b);
    });
  }, [shortcuts]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Atalhos de teclado</DialogTitle>
          <DialogDescription>
            Pressione <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">?</kbd> a qualquer momento.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {grouped.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhum atalho registrado.</p>
          )}
          {grouped.map(([group, items]) => (
            <div key={group}>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                {group}
              </h4>
              <ul className="space-y-1.5">
                {items.map((s) => (
                  <li key={s.id} className="flex items-center justify-between text-sm">
                    <span className="text-foreground">{s.label}</span>
                    <kbd className="px-2 py-0.5 rounded bg-muted text-xs font-mono text-muted-foreground border border-border">
                      {formatCombo(s.keys)}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
