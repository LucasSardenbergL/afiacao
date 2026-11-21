# /admin/customers: ordem por prioridade e filtro de saúde no servidor (2026-11-20)

**Problema.** No modo base completa (master/gestor), a lista paginava `profiles` por nome, 100 por página, e só depois buscava os scores da página. O filtro "Saúde" rodava em memória sobre as páginas carregadas. A própria tela admitia isso com "Nenhum cliente nas páginas carregadas até agora". Ordenar por prioridade no cliente ordenaria só os 100 primeiros por nome: o teto é o EIXO (CLAUDE.md, corte por ranking).

**Pré-requisito.** O #4032/#4036 fez a edge gravar `priority_score` NULL para `sem_historico`. Antes disso os 15,7 mil nunca-compradores tinham 67 cravado e ocupavam o topo.

**Entrega.** A RPC `public.listar_clientes_base(p_busca, p_saude, p_ordem, p_limite, p_offset)`, migration `20261121120001`:
- **SECURITY INVOKER**: valem as mesmas RLS da leitura direta (`profiles`, `fcs_select_carteira`). Score invisível ao chamador cai no LEFT JOIN como NULL, que é o "sem score" que a tela já mostrava.
- **Ordem `prioridade`**: `DESC NULLS LAST`, com desempate por `name` e `user_id`. A prioridade de `sem_historico` conta como NULL, mesmo que a edge volte a gravar número. A ordem `nome` (A–Z) é a de antes. Fica no estado `?ordem=` da URL, via `useUrlState`.
- **Filtro `p_saude`**: tem a mesma semântica do filtro em memória antigo. Classe = `health_class` e não `sem_historico`. `sem_historico` tem filtro próprio.
- **`total`**: é o count do recorte antes do LIMIT/OFFSET, repetido em toda linha. A tela mostra "X com esses filtros · N clientes na base".
- **Busca**: usa `private.padrao_like_contem`, exigido pelo `like-cru-em-migrations-gate`. Um termo só de curinga não casa nada; não vira "sem filtro".

**Carteira não mudou.** A ordem continua A–Z (`ordenarPorNome`) e o filtro continua em memória. A carteira é lida inteira, então o filtro em memória é completo, e não há controle de ordem nesse modo.

**Prova.** `db/test-listar-clientes-base.sh` (PG17): controle 29/29 e 9/9 sabotagens, cada uma acusada pelo próprio assert. A falsificação pegou uma cegueira do harness: sem o `ALTER DEFAULT PRIVILEGES` do Supabase (EXECUTE direto a `anon`), remover o `REVOKE … FROM anon` passava verde. No vitest, o controle ficou verde e as 4 sabotagens do front deram vermelho.

**Custo na PROD** (pré-voo psql-ro, 16.099 no recorte): cerca de 40 ms por página com cache quente e cerca de 870 ms a frio. O sort é top-N heapsort.
