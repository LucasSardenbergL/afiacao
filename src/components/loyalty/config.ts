// Tiers e helper de classificação do módulo de fidelidade.
// Extraídos verbatim de src/pages/AdminLoyalty.tsx (god-component split).

const TIERS = [
  { name: 'Bronze', min: 0, icon: '🥉' },
  { name: 'Prata', min: 200, icon: '🥈' },
  { name: 'Ouro', min: 500, icon: '🥇' },
  { name: 'Diamante', min: 1000, icon: '💎' },
];

export function getTier(balance: number) {
  return [...TIERS].reverse().find(t => balance >= t.min) || TIERS[0];
}
