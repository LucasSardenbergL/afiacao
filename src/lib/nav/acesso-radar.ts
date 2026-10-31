/**
 * Quem usa o Radar — o espelho de UI das capabilities do servidor (migration 20261029201200).
 *
 * - `podeProspectarRadar` = `private.cap_radar_prospectar`: master, gestor comercial ou vendedor
 *   (farmer/hunter/closer). Abre a tela, registra contato, assume lead e cadastra no Omie em 1 clique.
 * - `podeGerirRadar` = `pode_ver_carteira_completa`: master ou gestor comercial. Resolve conflito de
 *   cadastro, atribui tarefa, libera o lead de outro e roda o cadastro em massa.
 *
 * É cosmético (esconde o que o servidor recusaria): a fronteira é o banco. Para decidir o que MOSTRAR use os
 * sinais `display*` (a lente "Ver como"); para decidir o que o usuário PODE FAZER, os de `useAuth()` (reais).
 */
const GESTOR = new Set(['gerencial', 'estrategico', 'super_admin']);
const VENDEDOR = new Set(['farmer', 'hunter', 'closer']);

export interface SinaisAcessoRadar {
  /** `app_role` do usuário (real ou o da persona vista). */
  role: string | null;
  /** `commercial_role` cru do banco (pode trazer valores fora do union TS legado). */
  commercialRole: string | null;
}

export function podeGerirRadar({ role, commercialRole }: SinaisAcessoRadar): boolean {
  if (role === 'master') return true;
  return role === 'employee' && commercialRole != null && GESTOR.has(commercialRole);
}

export function podeProspectarRadar(s: SinaisAcessoRadar): boolean {
  if (podeGerirRadar(s)) return true;
  return s.role === 'employee' && s.commercialRole != null && VENDEDOR.has(s.commercialRole);
}
