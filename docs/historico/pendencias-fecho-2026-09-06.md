# Pendências do fecho de 2026-09-06 — a janela da fatia do preço ausente

O `/fecho` da sessão do preço ausente ([#2224](https://github.com/LucasSardenbergL/afiacao/pull/2224))
auditou **toda a janela**, não só o que a sessão tocou — migration e edge de terceiro entram na main
sem ninguém da sessão saber, e **também não se auto-aplicam**. Duas pendências apareceram assim, e
nenhuma era da fatia.

Estão aqui porque **chip é destino perecível**: ele mora dentro da sessão que o criou, e arquivada a
sessão não há caminho conhecido de volta até ele. O chip é o atalho; este texto é o destino.

## 1. Migration mergeada que nunca foi colada no banco

**`20260906151204_deploy_sonda_cron_fail_closed.sql`** está na main e **não** está no banco.

```
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'deploy_sonda_disparar';   -- 0
select count(*) from cron.job where jobname ilike '%sonda%';           -- 0
```

A função e o cron que ela instala não existem. É a armadilha de sempre — o Lovable Cloud só aplica
migration de nome UUID, gerada pelo builder; as de nome custom ficam no repo. **Merge ≠ banco.**

O que a torna pior que a média: ela instala um **sensor**. Um sensor que não existe não falha, não
alarma e não aparece — a ausência dele é indistinguível de "está tudo bem". Quanto mais tempo passa,
mais a equipe confia num vigia que nunca nasceu.

Chip: **"Aplicar migration deploy_sonda_cron_fail_closed"**.

## 2. Assimetria de privilégio entre duas funções irmãs

`20260906154202_cancelar_pedido_revoke_anon.sql` revogou `anon` do EXECUTE de
`cancelar_pedido_sugerido`. A irmã **`aprovar_pedido_sugerido`**, alterada na MESMA janela, ficou de
fora e mantém `anon` **e** `authenticated` com EXECUTE.

**Não é P0, e a razão importa mais que o veredito.** A função é SECURITY **INVOKER** e não tem gate
interno, então a RLS da tabela se aplica ao chamador: `pedido_compra_sugerido` está com RLS ativa e
a única policy de UPDATE atende `authenticated` exigindo `master`/`employee`. Para `anon` não há
policy aplicável ⇒ default-deny. O EXECUTE dele é **inócuo hoje**.

> O risco é de **composição**, não de estado. A defesa mora inteira numa camada. Quem tornar a
> função SECURITY DEFINER, ou acrescentar uma policy permissiva, converte um EXECUTE esquecido em
> caminho de escrita no money-path — aprovar pedido de compra. O padrão do repo, e a própria
> migration irmã, é fechar o privilégio **além** da RLS.

Duas armadilhas para quem for corrigir: `REVOKE FROM PUBLIC` **não** tira grant explícito de role
nomeada (revogue nomeando `anon, authenticated`); e antes de revogar de `authenticated`, descubra
quem chama — se o app chama via PostgREST como authenticated, revogar quebra a aprovação na tela.

Chip: **"Revogar anon do EXECUTE de aprovar_pedido_sugerido"**.

## 3 e 4. As duas que a fatia separou de propósito

Não são achados do fecho; são escopo recusado conscientemente, registrado para não virar memória.

- **`omie-vendas-sync:3161`** — a trava de crédito na edição faz `Number(…valor_unitario) || 0` sobre
  o `ConsultarPedido`. Item sem preço **reduz** `totalAtualOmie` e **afrouxa** o gate de aumento de
  exposição. É money-path e pede a própria medição e a própria prova; entrar de carona na fatia do
  preço teria misturado duas decisões de risco diferentes.
- **Catálogo de produto** (`omie_products.valor_unitario`, ~6 edges) mantém `|| 0`. Outro campo,
  outro consumidor. O gate textual da fatia é um **ratchet** que trava a única ocorrência restante e
  prova que ela é a do catálogo — se alguém adicionar outra, o teste acusa.
