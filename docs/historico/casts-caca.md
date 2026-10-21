# Casts que desligam o tipo — módulo caça (plano v2 · item 4 / I1)

2026-10-20. Último cast de módulo ativo fora de farmer-inteligencia e financeiro, depois do [casts-plataforma.md](casts-plataforma.md) (#3262). Escopo: `src/hooks/useCaca.ts`, com 1 cast.

## O que o cast escondia

- **As views `v_caca_compradores`/`v_caca_candidatos` estavam no `types.ts`.** O comentário "não estão no types.ts gerado" era falso, como em todos os PRs do item. O builder estrutural `cacaFrom` (`supabase as unknown as { from(v: string) … }`) desligava coluna, ordem e retorno das duas leituras paginadas.
- **A view perde o NOT NULL** (no `types.ts`, toda coluna é `| null`), e `empresa`/`empresa_alvo` são texto. A borda nova `src/lib/caca/linha-view.ts`:
  - exige as colunas sem as quais a linha não faz sentido. São documento, empresa, famílias e as métricas do comprador (volume, pedidos, recência, cobertura de lucro); no candidato, compra em outra empresa e `cliente_user_id`;
  - guarda a empresa pelo vocabulário de `EmpresaAlvo`, incluindo `colacor_sc`, que a fila descarta depois (teste existente em `fila.test.ts`);
  - lança fora disso (ausente ≠ zero).
- Medido em prod via `psql-ro` (2026-10-20): 0 nulos nessas colunas em 1.691 compradores e 10.799 candidatos, e só `oben`/`colacor` em empresa. A borda não muda nada do que a tela mostra hoje; ela só passa a acusar quando a view mudar.

## O que ficou

- Teste novo: `src/lib/caca/__tests__/linha-view.test.ts` (coberto pelo glob `src/lib/caca/**` do manifesto).
- Gate `casts:stale` inalterado (47 · `from 21 · rpc 26`): o cast era sobre o cliente, não sobre um literal `.from('x' as never)`.
