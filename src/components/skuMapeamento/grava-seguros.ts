import type { SugestaoSegura } from '@/lib/reposicao/sayerlack-sku';

/**
 * Particiona os mapeamentos "seguros" (auto-extraídos) em:
 *  - `novos`: sem linha no banco → a inserir;
 *  - `pulados`: JÁ têm linha (ativa OU inativa) → nunca sobrescrever (revisão manual).
 *
 * `skusExistentes` deve ser RE-CONSULTADO no banco no momento da gravação (não do snapshot
 * do react-query da validação) — fecha a janela de corrida em que outro usuário cria/corrige
 * um mapa ativo entre validar e gravar. O auto-apply só INSERE; nunca atualiza um de-para
 * existente (que pode ser um mapa manual correto, ou um inativo intencional). Catch do codex.
 */
export function dividirSegurosParaGravar(
  seguros: SugestaoSegura[],
  skusExistentes: Set<string>,
): { novos: SugestaoSegura[]; pulados: string[] } {
  const novos = seguros.filter((s) => !skusExistentes.has(s.sku_omie));
  const pulados = seguros.filter((s) => skusExistentes.has(s.sku_omie)).map((s) => s.sku_omie);
  return { novos, pulados };
}
