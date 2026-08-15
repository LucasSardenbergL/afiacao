/**
 * authz-reescritas-conhecidas.ts — baseline das migrations que recriam função do AUTHZ_MANIFEST
 * reescrevendo a definição VIVA (`pg_get_functiondef` + `EXECUTE`), sem `CREATE FUNCTION`.
 * ============================================================================================
 *
 * Para essas funções a **Parte A não mede a última definição** — ela mede o último `CREATE` que
 * existe como texto, e o banco tem outra coisa. A entrada aqui NÃO diz "está tudo bem": ela
 * DECLARA o não-medido, para que o verde do `authz:check` pare de afirmar cobertura que não tem.
 * Cada entrada vira AVISO no CI (visível, nomeando arquivo e função) em vez de erro.
 *
 * ⚠️ Migration committada é IMUTÁVEL neste repo, então "o autor reescreve como CREATE OR REPLACE"
 * só vale para o FUTURO. As entradas abaixo são o passado medido; qualquer reescrita NOVA de
 * função do manifest é ERRO até ser reescrita de forma auditável ou classificada aqui.
 *
 * `md5ProdEsperado` é o md5 do `prosrc` NORMALIZADO em produção, medido por `psql-ro`:
 *   md5(regexp_replace(btrim(prosrc), '\s+', ' ', 'g'))
 * O CI **não** confere (não tem prod). Quem confere é `bun run authz:audit:prod`, que também roda
 * o `checkGate` no corpo VIVO. É isso que fecha o laço: a baseline vira asserção verificável em
 * vez de desculpa, e drift futuro no corpo aparece como md5 divergente.
 */
export interface ReescritaConhecida {
  /** migration que faz a reescrita (o arquivo que a Parte A não consegue ler como definição) */
  arquivo: string;
  /** chave `schema.nome` do AUTHZ_MANIFEST */
  funcao: string;
  motivo: string;
  /** a prova que de fato mede o corpo que RODA (executada, não textual) */
  provaExecutada: string;
  /** md5 do prosrc normalizado em prod, medido 2026-08-14 por psql-ro */
  md5ProdEsperado: string;
}

export const AUTHZ_REESCRITAS_CONHECIDAS: ReescritaConhecida[] = [
  {
    arquivo: '20260718190000_authz_capability_matrix_e2.sql',
    funcao: 'public.get_preco_cockpit',
    motivo:
      'FU4/E2 trocou o gate `pode_ver_carteira_completa` por `private.cap_custo_ler` por regexp sobre a definição viva, porque o corpo do repo divergia de prod e colar um corpo teria REVERTIDO o hardening. Efeito medido: em prod esta função já NÃO chama pode_ver_carteira_completa, mas o manifest ainda a lista como alternativa aceitável e o corpo do repo ainda a chama — o CI valida uma cláusula que prod não tem mais. O gate que de fato protege em prod é has_role(employee|master), e ele satisfaz o anyOf.',
    provaExecutada: 'db/test-authz-capability-matrix.sh',
    md5ProdEsperado: '4f3fb7df939e467f82d36a065e2f0957',
  },
  {
    arquivo: '20260718190000_authz_capability_matrix_e2.sql',
    funcao: 'public.get_defasagem_cliente',
    motivo:
      'Mesma reescrita do E2, mesmo motivo. Em prod `pode_ver_carteira_completa` sobrou só como MENÇÃO em comentário (não é chamada); quem bloqueia é has_role(employee|master) + cap_custo_ler para o numérico.',
    provaExecutada: 'db/test-authz-capability-matrix.sh',
    md5ProdEsperado: '037ede84a229d5798214511433afb65d',
  },
  {
    arquivo: '20260814022626_reposicao_po_inexistente_antes_de.sql',
    funcao: 'public.reposicao_pos_candidatos',
    motivo:
      'Troca cirúrgica do predicado do guard temporal (omie_registrado_em → omie_po_inexistente_antes_de) preservando por construção SECURITY DEFINER, STABLE, SET search_path, o gate FU4-G e as colunas de frescor da 20260814000125. Aplicada em prod (medido: o corpo vivo tem o predicado CAUSAL e não tem o antigo; o last-writer do repo, 20260814000125, tem o inverso). É o caso que provou que o padrão é recorrente e não acidente: o FU4-G já reescrevera a MESMA função 25 dias antes.',
    provaExecutada: 'db/test-pos-candidatos-guard-temporal.sh (N1 roda a RPC como não-staff e exige 42501)',
    md5ProdEsperado: '632964445c40e792ca62d945aeb2e85e',
  },
];

/** chave de casamento — arquivo + função, porque uma migration pode reescrever várias */
export function chaveReescrita(arquivo: string, funcao: string): string {
  return `${arquivo}::${funcao}`;
}

export const REESCRITAS_CONHECIDAS_INDEX = new Map(
  AUTHZ_REESCRITAS_CONHECIDAS.map((r) => [chaveReescrita(r.arquivo, r.funcao), r]),
);
