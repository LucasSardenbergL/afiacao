// Helpers de apresentação das paradas de rota.
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).

export const formatDuration = (min: number) => {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
};
