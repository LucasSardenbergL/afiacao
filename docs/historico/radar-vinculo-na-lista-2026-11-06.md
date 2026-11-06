# Radar: selo de "possível sucessor / vínculo com cliente" na LISTA (2026-11-06)

> Continuação de [radar-sucessor-viabilidade-2026-11-04.md](radar-sucessor-viabilidade-2026-11-04.md). O pedido
> original era o selo "na lista E na ficha". A ficha foi entregue em #3606. A lista ficou de fora porque precisava de
> uma versão em lote. Esta entrega é essa versão.

## O que mudou

- **Migration `20261106083754_radar_vinculos_em_lote.sql`:**
  - **`private.radar_vinculos_nucleo(p_cnpjs, p_carteira)`** é a ÚNICA cópia das regras do vínculo: chave
    exclusiva (≤ 2 raízes), o contador derruba telefone e e-mail, pessoa só no mesmo município, 'forte' = pessoa ou
    ≥ 2 sinais, 'media' = endereço completo sozinho, mesma raiz fica de fora, cliente só-profiles só com carteira e
    até 10 vínculos por lead, na ordem da ficha. Não tem gate e fica fechado para PUBLIC, `anon` e `authenticated`.
  - **`radar_possiveis_vinculos(p_cnpj)`** (a ficha) virou invólucro, com o mesmo gate, a mesma validação, as mesmas
    colunas e a mesma ordem.
  - **`radar_vinculos_por_cnpjs(p_cnpjs)`** (a lista) aceita até 200 CNPJs e devolve uma linha por lead com vínculo:
    força do 1º, quantos clientes, e os nomes e situações na ordem da ficha.
  - Molde TRAVA → PRE → CREATE → PÓS: a PRE aceita só o md5 vivo da ficha de #3606 (`797fdff…`) ou o deste arquivo.
- **Linha da lista (`RadarLinha`):** chip "possível sucessor" (algum cliente do vínculo está nulo, suspenso, inapto ou
  baixado na Receita) ou "possível vínculo". O tom vem da força. O título nomeia o cliente e manda conferir na ficha.
  Leitura com falha vira "vínculo?", nunca "sem chip". O mapa de "fora de operação" é o mesmo da ficha
  (`src/lib/radar/vinculos.ts`), então a regra de "sucessor" também não duplicou.
- **Hook `useRadarVinculosLista`:** uma chamada por página (as mesmas páginas do selo de filial, inclusive a da
  amostra), com chave estável.

## Por que um núcleo, e não "a lista chama a ficha 50 vezes" (medido em prod, `psql-ro`)

| Medição (o corpo com os helpers expandidos, `EXPLAIN ANALYZE`) | Tempo |
|---|---:|
| Ficha, 1 CNPJ (antes e depois) | ~850 ms |
| Lista em laço: 50 × ficha (estimado) | ~42 s |
| Lista pelo núcleo: 1 chamada com a página do topo do score (50 leads) | **1,19 s** |

Quase todo o custo da ficha é recalcular a chave de telefone dos ~15 mil `profiles` (~360 ms) e o CEP dos ~16,9 mil
`addresses` (~210 ms) a cada chamada. Esse trabalho não depende do lead. No núcleo em conjunto, ele roda uma vez por
página. Na página do topo do score, **5 de 50** leads têm vínculo.

## Prova

`db/test-radar-vinculos-em-lote.sh` (no `db/nucleo-ci.txt`): **23 asserts** e **14 sabotagens**, todas vermelhas no
assert certo, em `LC_ALL=C` e em `pt_BR.UTF-8`, com o controle verde na mesma invocação.

- **F1–F13:** os cenários da ficha de #3606, agora sobre o núcleo. Inclui um lead com 2 clientes (forte antes de média).
- **L4/L5:** lead a lead, em todos os leads da base, a lista é o resumo exato da ficha, para o gestor e para o
  vendedor (0 divergentes). Sabotar a agregação, ou passar a carteira para quem não a lê, deixa esses dois vermelhos.
- **L1, L2, L3, L7, L8, L9, L10:** gate, teto de 200 (200 passa, 201 recusa), CNPJ repetido ou inválido ignorado,
  lista vazia ou nula, núcleo inacessível ao JWT e ACL.
- **`deriva`:** outra sessão recriou a ficha depois do pré-voo, e a PRE aborta o apply.

Uma camada saiu por ser redundante: o filtro de formato e o `DISTINCT` na entrada da lista não mudavam nenhum
resultado, porque o núcleo casa por `cnpj = ANY` em `radar_empresas`.

## Deploy

1. Migration por `bun run db:aplicar` (ensaio com ROLLBACK antes) e validação por `psql-ro` (md5 dos 3 corpos e ACL).
   ✅ Aplicada em 06/11 (`db_aplicacoes` tentativa #918). `psql-ro` conferiu: núcleo `bc00b310…` sem DEFINER e
   fechado ao JWT, ficha `2452f463…` e lista `a9278dd0…` com DEFINER, fechadas a `anon` e abertas ao JWT.
2. Publish do front pelo founder; conferir o `radar_vinculos_por_cnpjs` no bundle servido em `steu.lovable.app`.
   ✅ No ar em 06/11. O PR #3656 (squash `af0956dc4`) mergeou às 13:24Z.
   - `monitor-deploy.sh --pr 3656` voltou `PR_NO_AR`: o ar serve `3dad9809`, que descende do squash.
   - `verify-frontend.sh --pai af0956dc4^` voltou exit 0: a sentinela é exclusiva (0 ocorrências no pai) e está em
     `RadarClientes-BHS5WR4l.js`, com o controle negativo OK. No mesmo chunk estão `selo-vinculo-` e
     `possível sucessor`.
   - O sync do Lovable não reverteu nada: os símbolos seguem nos 5 arquivos de `src/` em `origin/main`.
   - QA visual: print do founder em 06/11, no preview do Lovable em `/radar`, logado. O chip aparece depois dos
     selos de filial. "possível vínculo" sai azul (pista média), em METALURGICA AMAPA S.A., que também é filial de
     cliente: o vínculo é com OUTRA raiz, como manda a regra. Sai laranja (pista forte) em AGIL FLORESTAL e LUARTE
     MOVEIS. Nesse trecho não apareceu nenhum "possível sucessor".
   - Nota de design, sem mudança: o laranja da pista forte é o mesmo tom do "filial de cliente". Só vale revisitar se
     o Radar ganhar uso, porque hoje ele está em fase sem sinal.

## Quando medir ("quando" é query)

Não há evento novo: o chip é determinístico e abrir a ficha já grava `radar_eventos.evento='abriu'`. A pergunta
"o chip leva a abrir a ficha?" se responde com os leads abertos por humano (denominador da query do parecer de 04/11)
cruzados com os que têm vínculo, que se tiram pela RPC com o JWT de quem prospecta.
