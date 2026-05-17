import { useCallback, useMemo, useState } from 'react';
import { PERSONA_CONFIG, type Persona, type ZoneId, ZONES } from '@/lib/dashboard/persona-config';
import { track } from '@/lib/analytics';

interface StoredLayout {
  /** Ordem custom escolhida pelo usuário. Subset/superset de ZONES — código defensivo abaixo. */
  order: ZoneId[];
  /** Zonas que o usuário escolheu esconder. */
  hidden: ZoneId[];
}

const STORAGE_PREFIX = 'dashboardLayout-';

function storageKey(persona: Persona): string {
  return `${STORAGE_PREFIX}${persona}`;
}

function readStored(persona: Persona): StoredLayout | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(persona));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredLayout;
    // Sanitização defensiva: filtra apenas ZoneIds válidos (defesa contra migração de PERSONA_CONFIG)
    const validZones = new Set<ZoneId>(ZONES);
    const order = (parsed.order ?? []).filter((z): z is ZoneId => validZones.has(z));
    const hidden = (parsed.hidden ?? []).filter((z): z is ZoneId => validZones.has(z));
    return { order, hidden };
  } catch {
    return null;
  }
}

function writeStored(persona: Persona, layout: StoredLayout): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(storageKey(persona), JSON.stringify(layout));
  } catch {
    /* quota / private mode — silencia */
  }
}

function clearStored(persona: Persona): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(storageKey(persona));
}

/**
 * Layout do cockpit (ordem + hidden) per persona, com persistência em
 * localStorage. Sem customização, devolve o `zoneOrder` default da persona.
 *
 * Quando usuário customiza, a custom order respeita só zonas válidas; novas
 * zonas que aparecerem em futuras versões caem no FINAL da ordem
 * automaticamente. Hidden persiste idem.
 */
export function useDashboardLayout(persona: Persona) {
  const [stored, setStored] = useState<StoredLayout | null>(() => readStored(persona));

  // Persona mudou? Re-ler storage (snapshot inicial pode estar errado).
  // Implementação simples: usa `persona` como key implícito via useMemo abaixo.

  const isCustomized = stored !== null;

  const visibleZones = useMemo<ZoneId[]>(() => {
    const personaOrder = PERSONA_CONFIG[persona].zoneOrder;
    if (!stored) return personaOrder;

    // Build ordem final: custom order primeiro, depois zonas novas no final.
    const inCustom = new Set(stored.order);
    const newZones = personaOrder.filter((z) => !inCustom.has(z));
    const combined = [...stored.order.filter((z) => personaOrder.includes(z)), ...newZones];

    // Filtra hidden
    const hiddenSet = new Set(stored.hidden);
    return combined.filter((z) => !hiddenSet.has(z));
  }, [stored, persona]);

  const hiddenZones = useMemo<ZoneId[]>(() => {
    if (!stored) return [];
    return stored.hidden;
  }, [stored]);

  const reorder = useCallback((fromIndex: number, toIndex: number) => {
    setStored((prev) => {
      const base = prev?.order ?? PERSONA_CONFIG[persona].zoneOrder;
      const next = [...base];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return prev;
      next.splice(toIndex, 0, moved);
      const layout: StoredLayout = { order: next, hidden: prev?.hidden ?? [] };
      writeStored(persona, layout);
      track('dashboard.layout.reordered', { persona, from: fromIndex, to: toIndex, zone: moved });
      return layout;
    });
  }, [persona]);

  const hide = useCallback((zone: ZoneId) => {
    setStored((prev) => {
      const baseOrder = prev?.order ?? PERSONA_CONFIG[persona].zoneOrder;
      const baseHidden = prev?.hidden ?? [];
      if (baseHidden.includes(zone)) return prev;
      const layout: StoredLayout = { order: baseOrder, hidden: [...baseHidden, zone] };
      writeStored(persona, layout);
      track('dashboard.layout.zone_hidden', { persona, zone });
      return layout;
    });
  }, [persona]);

  const show = useCallback((zone: ZoneId) => {
    setStored((prev) => {
      const baseOrder = prev?.order ?? PERSONA_CONFIG[persona].zoneOrder;
      const baseHidden = prev?.hidden ?? [];
      if (!baseHidden.includes(zone)) return prev;
      const layout: StoredLayout = { order: baseOrder, hidden: baseHidden.filter((z) => z !== zone) };
      writeStored(persona, layout);
      track('dashboard.layout.zone_shown', { persona, zone });
      return layout;
    });
  }, [persona]);

  const reset = useCallback(() => {
    clearStored(persona);
    setStored(null);
    track('dashboard.layout.reset', { persona });
  }, [persona]);

  return { visibleZones, hiddenZones, isCustomized, reorder, hide, show, reset };
}
