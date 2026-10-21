# Último cast de módulo ativo — `useVendaPainel` (plano v2 · item 4 / I1)

2026-10-21. Depois do [casts-caca.md](casts-caca.md) e do fecho do ciclo 2, sobrava um cast em módulo ativo: `src/hooks/useVendaPainel.ts` (painel do founder e repasse de preço do programa Venda por cliente). Ele **era o único legítimo**: as RPCs não estavam no `types.ts`.

## O que estava por trás

- **O `types.ts` estava defasado em 8 das 18 funções `venda_*` da prod**: `venda_aprovar_repasse`, `venda_avaliar_ondas`, `venda_cidades_alvo`, `venda_gerar_lista`, `venda_painel`, `venda_reconstruir_historico`, `venda_repasse_candidatos`, `venda_revogar_repasse`. A causa é a documentada em [database.md](../agent/database.md): o Lovable só regenera os tipos quando **ele** aplica a migration, e as do programa foram coladas no SQL Editor.
- **O comentário do hook ("NÃO adicionar à mão") contrariava a regra viva** (#1450: adicionar à mão no formato do gerador). Escrevi as 8 entradas a partir de `pg_get_function_arguments`/`pg_get_function_result` da prod. Antes do PR, o Lovable regenerou o `types.ts` na main (`aafdc432b`/`b74f4d162`) com as mesmas 8 entradas, **idênticas byte a byte** às minhas. Fiquei com o arquivo gerado, e o PR não toca o `types.ts`.
- **O cast escondia os retornos, não os nomes.** `venda_painel` e `venda_repasse_candidatos` devolvem `jsonb`, e o wrapper afirmava `PainelVenda`/`CandidatoRepasse[]`. A borda nova `src/lib/venda-cliente/painel-rpc.ts` lê os dois por forma, contra o corpo das funções em prod:
  - toda chave é sempre montada por `jsonb_build_object`, então chave ausente lança;
  - NULL só é aceito onde a função o produz: nome, receita, taxas, `ligada_em`, `condicao_ao_ligar`, preço sugerido, `repasse_atual`;
  - `repasse_vigente` NULL continua NULL ("não sei", tabela da Task 6 ausente), nunca `false`;
  - `empresa` fora de `oben` lança (repasse v1);
  - a evidência de custo extra (`c_last`/`c_now`) é ignorada, não repassada.
- `p_substitui` NULL (trio sem histórico) virou chave ausente. Dá no mesmo: a função tem `DEFAULT NULL`, conferido em prod.

## O que ficou

- Teste novo `src/lib/venda-cliente/__tests__/painel-rpc.test.ts` (11 casos), falsificado na mesma invocação. Com o controle verde, sabotar a guarda de chave ausente derrubou os 2 testes dela, e sabotar a guarda de empresa derrubou o dela.
- Módulos ativos com **0** cast que desliga o tipo. Gate `casts:stale` inalterado: o cast era sobre `supabase.rpc`, não um literal.
