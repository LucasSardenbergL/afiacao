# Clientes (/admin/customers): sensor de uso no ledger (2026-11-21)

**Por quê.** O programa da tela Clientes (#4027 números não fabricados · #4028 NULLS LAST · #4032/#4036 prioridade
NULL sem histórico · #4044 "Priorizar contatos" e saúde no servidor · #4057 polimento · #4060/#4063 churn NULL ·
#4061/#4065 A–Z normalizado) foi todo para produção **sem nenhum `track()`**. A fase seguinte (atalhos "Em risco" /
"Primeira compra") só sai com sinal positivo **com denominador** ([fase-sem-sinal.md](fase-sem-sinal.md)), e o
PostHog é censurado no Chrome do founder. Por isso o sinal nasce no **ledger** (`analytics_outbox` via
`analytics_ledger_registrar`), não em tabela nova.

## O que mede

| evento | quando | chave de dedup (1 linha por titular × chave × dia UTC) | props |
|---|---|---|---|
| `clientes.lista_aberta` | lista montou pronta (1x por montagem) | `modo` | `modo` |
| `clientes.modo_trocado` | trocou a ordem (menu ou cabeçalho), só se mudou | `de>para` | `de, para, origem` |
| `clientes.filtro_saude` | escolheu valor no menu Saúde, só se mudou | `modo:valor` | `modo, valor` |
| `clientes.busca_usada` | termo debounced não vazio, digitado | `modo` | `modo` |
| `clientes.cliente_aberto` | clique numa linha da lista | `modo:filtro:b\|s:posição` | `modo, posicao, filtro_saude, com_busca` |
| `clientes.pagina_carregada` | "Carregar mais" ou scroll infinito | `modo:página` | `modo, pagina` |

`modo` ∈ `prioridade | nome | carteira`. A carteira (sales-only) é sempre A–Z e não tem controle de ordem.

**LGPD:** o payload é fechado por tipo e só leva enums, inteiros e booleanos. O teste trava uma allowlist de chaves.
Nenhum id, nome, documento, telefone ou termo de busca sai do navegador, nem na chave de dedup (o clique é
identificado pela posição). Valor de filtro fora do enum (URL editada à mão) vira `outro`.

**Lente "Ver como":** não registra em nenhum dos dois canais, para que a inspeção do master não infle o denominador.

## Denominador e leitura

[`db/sensor-clientes-adocao.sql`](../../db/sensor-clientes-adocao.sql), rodada via
`~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sensor-clientes-adocao.sql`:

1. **denominador**: usuários distintos e usuário-dias que abriram a tela (`navegacao.rota_servida` em
   `/admin/customers%` **ou** `clientes.lista_aberta`), por papel (o mais alto em `user_roles`);
2. **adoção**: para cada evento × papel, `usuarios / denominador`;
3. **detalhe**: modo de abertura, troca `de>para (origem)`, filtro por valor, posição do clique em faixas
   (1–10 · 11–50 · 51+) e páginas.

⚠️ **Retenção curta:** a linha drenada é purgada ~7 dias depois (`purgar_em`). Ausente ≠ não usou. Rode dentro da
janela e cole o resultado aqui se precisar de série.

## Limites conhecidos (deliberados)

- O ledger mede **quem/dia com qual valor**, não frequência de clique. Para frequência, o `track()` paralelo
  (PostHog, censurável) leva o mesmo nome e as mesmas props.
- Aplicar segmento salvo ou "Limpar filtros" não conta como `filtro_saude`: só o menu Saúde conta.
- A cota do ledger é de 500 linhas por titular a cada 24h, somando todos os eventos. Um dia com mais de ~400
  cliques distintos (posição × filtro × busca) satura o teto e o resto é descartado em silêncio.
- O Service Worker só troca de build quando o cliente clica: bytes no ar ≠ adoção.

## Prova

- PG17: `db/test-analytics-ledger-clientes.sh` (no núcleo do CI via `db/nucleo-ci.d/`). Roda em `C` e em `pt_BR.UTF-8`
  com 22 asserts e 5 sabotagens (PÓS por md5, PÓS por evento novo, PÓS por evento antigo, REVOKE de anon, PRE contra
  deriva), com controle verde na mesma invocação. Também roda a query de adoção sobre dados semeados e confere o
  denominador por papel.
- **Lição do harness:** sem `psql -1` a migration sabotada **comita o `CREATE OR REPLACE` antes de a PÓS abortar**, e
  a sabotagem seguinte falha "por outro motivo" (a PRE vê o corpo sabotado). O `db:aplicar` é transacional, então a
  prova tem de aplicar com `-1`. A outra armadilha: o `sed` de sabotagem casava a mesma linha da allowlist no array
  da PÓS, e a sabotagem se anulava (MUDA). A correção foi sabotar só a 1ª ocorrência.
- vitest: `sensorClientes.test.ts` (payload sem PII, chaves, lente) e `CustomerListView.sensor.test.tsx` (disparo
  real na tela). A paridade allowlist × `EventoLedger` fica em `analytics-ledger-paridade.test.ts`.
