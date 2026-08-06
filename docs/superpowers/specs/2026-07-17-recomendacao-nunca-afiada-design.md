# Recomendação `nunca_afiada` — 4ª regra determinística (benchmark #13)

**Data:** 2026-07-17 · **Escopo:** 1 PR frontend, sem migration/edge · **Deploy:** Publish no Lovable.

## Problema (verificado em produção, psql-ro)

Toda a base viva do app do cliente são **4 `user_tools` em 2 clientes**, todas categoria
"Serra Circular de Widea", com `next_sharpening_due`, `last_sharpened_at` e
`sharpening_interval_days` **NULL** e `suggested_interval_days` (categoria) = 120.
A tabela `orders` está **vazia** (0 pedidos).

Pelas 3 regras atuais de `src/lib/afiacao/recomendacoes.ts` nenhum card renderiza:
- `possivelmente_atrasada` exige `last_sharpened_at` (para projetar last+intervalo) → false.
- `sem_programacao` exige intervalo nulo, mas a categoria dá 120 → false.
- `economia` exige pedidos entregues → null (e a Central oculta 'economia').

**Buraco conceitual:** ferramenta cadastrada + intervalo conhecido + NUNCA afiada
(`last` NULL) + sem agendamento (`next_due` NULL) cai num limbo — lida como "tem
programação" (tem intervalo), mas sem data alguma para calcular. Atinge justamente o
cliente recém-chegado, onde o empurrão mais importa.

**Agravante descoberto:** a `main` (PR #1372) já tirou a seção de recomendações da home
— o empurrão do cliente novo passou a depender do `PriorityCard`. Mas `all_good` é o
último degrau de `priority.ts` e não olha histórico: 1 dos 2 clientes reais (com endereço)
lê **"Tudo em dia! Suas ferramentas estão bem cuidadas"** sem nunca ter afiado.
Mesma família de erro que "ausente ≠ zero".

## Solução

Nova regra determinística `nunca_afiada` = `next_sharpening_due IS NULL AND
last_sharpened_at IS NULL` (independe do intervalo — fato verificável, sem inferência,
sem fabricar número).

### 1. Helper puro `recomendacoes.ts` (fonte única do predicado)

- Exporta `ehNuncaAfiada(t: { next_sharpening_due; last_sharpened_at })`.
- Novo tipo `{ tipo: 'nunca_afiada'; ferramentas: FerramentaAfetada[] }`.
- **Precedência por exclusão mútua** (não por ordem frágil): `ehSemProgramacao` passa a
  exigir `last_sharpened_at != null`. Cada ferramenta cai em EXATAMENTE um balde:

  | next_due | last | intervalo | regra |
  |---|---|---|---|
  | NULL | NULL | qualquer | **nunca_afiada** (as 4 de produção) |
  | NULL | set | set, projeção vencida | possivelmente_atrasada |
  | NULL | set | NULL | sem_programacao |
  | set  | — | — | agendada → PriorityCard (fora das consultivas) |

  `possivelmente_atrasada` (last≠null) e `nunca_afiada` (last=null) já são exclusivas.
- Ordem de apresentação: `possivelmente_atrasada → nunca_afiada → sem_programacao → economia`.

### 2. Card na Central — `RecomendacoesCliente.tsx`

Card `nunca_afiada`: ícone `CalendarPlus`, título "N ferramenta(s) cadastrada(s), ainda
sem afiação", descrição com nomes + "agende a primeira afiação para começar", CTA
"Agendar afiação" → `/new-order`. **Não** entra em `ocultarTipos` (é o alcance-alvo).

### 3. Home — `priority.ts`

Novo degrau `nunca_afiada` **imediatamente antes de `all_good`**, reusando `ehNuncaAfiada`
(mesmo predicado). `variant: 'default'` (convite, não alarme), CTA → `/new-order`. Só
substitui a falsa tranquilidade: `quote`/`tools_overdue`/`no_tools`/`no_address` intactos
(o cliente sem endereço segue vendo "Cadastre um endereço").

## Testes (TDD)

- `recomendacoes.test.ts`: novo `describe` nunca_afiada (dispara; precede sem_programacao;
  exclusivo de possivelmente_atrasada; com/sem intervalo). Consertar 3 fixtures que mudam
  de balde (dar `last` SET onde o alvo era sem_programacao).
- `priority.test.ts`: "tudo em dia" ganha `last` + `next` futuro (all_good legítimo);
  +teste do degrau nunca_afiada disparando antes de all_good.
- `CentralFerramenta.test.tsx`: +teste com as 4 ferramentas reais (all-null + categoria 120)
  provando que o card aparece.

## Verificação

Sem QA visual por impersonação (lente "Ver como" não lista clientes de afiação, só farmers).
Validar por `bun run typecheck` + `bun run test` + bytes (skill lovable-deploy-verify).

## Fora de escopo (anotado)

Cabeçalho de `recomendacoes.ts` cita `docs/historico/benchmark-concorrentes-marcenaria-2026-07.md`,
que só existe no PR #1305 (aberto) — referência morta, não é arquivo desta entrega.
