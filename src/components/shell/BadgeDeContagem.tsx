/** A pílula "?" — mesma geometria do badge numérico, com a cor de aviso e o motivo acessível. */
export function BadgeIndisponivel({ motivo }: { motivo: string }) {
  return (
    <span
      data-testid="nav-badge-indisponivel"
      title={motivo}
      aria-label={motivo}
      className="ml-auto text-2xs rounded-full px-1.5 py-0.5 min-w-[18px] text-center border bg-status-warning-bg border-status-warning/30 text-status-warning"
    >
      ?
    </span>
  );
}
