# Caça — candidatos re-agregados por linha (Nested Loop sobre estimativa rows=1)

**Migration:** `20261126235000_caca_candidatos_plano_materializado.sql` · **APLICADA** em 2026-11-27 por `db:aplicar` (recibo #1509, PR #4243) · **sem edge · sem Publish** (só banco).

## Sintoma
A página de candidatos da Caça (`useCaca` → `v_caca_candidatos`, 32 páginas sequenciais de 1.000 via
`.range()`; a view tem **31.786** linhas, não as ~10k do comentário do hook) não carregava. No ensaio da
onda D (fatia 3) a view inteira passou de 300 s, antes e depois do corte de PII.

## Causa (provada no plano da prod, farmer `700657a1…` sob `authenticated`)
- O anti-join `cli_doc × alvos` contra `ativ` era estimado em **rows=1** (`DISTINCT ON` sobre CTE vira
  200 grupos por default, e o planejador supõe que `ativ` cobre todos). Real: 31.786.
- Com "1 linha" do lado de fora, `fam_grupo` (GroupAggregate sobre 74k `order_items`) e a
  `v_perfil_contato` (16k `profiles` + SubPlans) entravam como lado **interno de Nested Loop**, ou seja,
  eram re-executados para cada candidato.
- **Não é** RLS cara: as policies das tabelas base são InitPlan, e `v_perfil_chaves_internas` (169 ms) e
  `v_perfil_contato` (6 ms) isoladas são baratas. É o plano.

## Correção (mesma semântica)
1. A atividade por documento vira um array `contas_ativas`, e o filtro "ativo na empresa-alvo" e o
   `compra_em_outra_empresa` passam a ler o array, sem o anti-join que colapsava a estimativa.
2. `grupo`, `fam_grupo`, `cid`, `optout_doc`, `cand` e o contato (`v_perfil_contato`) viram CTEs
   `MATERIALIZED`: cada um é calculado uma vez.

## Antes / depois (prod, ensaio com ROLLBACK)
| Medida | Antes | Depois |
|---|---|---|
| 1ª página, farmer sob `authenticated` (conector Lovable, `SET TRANSACTION READ ONLY` + `SET LOCAL ROLE`) | **> 60 s** (timeout do conector) | **870 ms** (só hash joins) |
| view inteira, todas as colunas, envelope (postgres + JWT da farmer) | **> 300 s** (timeout) | **830 ms** (farmer) · 927 ms (master) |
| equivalência linha a linha (`db/medir-caca-candidatos-equivalencia.sql`) | — | md5 **igual** nas 2 personas, n=31.786; sabotagem (`<>`→`=`) dá vermelho com `EQUIVALENCIA QUEBRADA` |

**Pós-apply (prod, view viva, farmer sob `authenticated`):** última página 3,98 s no 1º toque (cache frio, planejamento 44 ms), depois 2 páginas na MESMA consulta couberam num teto de 3 s (< 1,5 s cada); view inteira com todas as colunas coube no `statement_timeout=8s` com md5 `eac8551f…` = o da view antiga pré-apply (n=31.786). Corpo vivo tem `contas_ativas AS MATERIALIZED`, `security_invoker=on`, anon sem SELECT.

A tela continua fazendo 32 requisições em sequência: ~32 × ~0,9 s ≈ 30 s no total, contra "nunca" antes,
e cada requisição fica bem abaixo do `statement_timeout=8s` do `authenticated`. Reduzir o número de idas
(ler numa ida só, ou pré-agregar) é outra entrega.

## Lições
- **`count(*)` sobre view mede outra consulta.** O planejador remove os LEFT JOINs cujas colunas não são
  usadas, justamente os caros. Os ensaios de "antes" com `count(*)` deram 400 ms numa view que não
  termina. Para medir uma view, projete **todas as colunas** (`md5(string_agg(z::text …))`).
- **O envelope (`db:aplicar --ensaio`) roda como dono das tabelas**, sem RLS de tabela, e não aceita
  `SET ROLE` (SECURITY DEFINER). Para o plano real de uma persona, use o conector Lovable com
  `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL ROLE authenticated; set_config('request.jwt.claims', …);
  EXPLAIN …; ROLLBACK;`. Só plano e tempo voltam (metadado), nenhuma linha de negócio.
- Mesma família do achado da fatia 3 (`has_role` por linha em CTE não materializado): em view com
  vários CTEs agregados, estimativa colapsada + Nested Loop = agregado re-executado por linha.
  `MATERIALIZED` no que é caro e reutilizado é o remédio barato.
