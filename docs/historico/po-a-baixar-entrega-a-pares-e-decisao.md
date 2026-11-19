# Fila "PO a baixar no Omie" — Entrega A: pares item a item + registro da decisão (2026-11-18)

Predecessoras: #3967 (fila só-leitura, `reposicao_po_a_baixar`) e #3975 (sombra v1.11 relê pendentes até o desfecho).
Migration: `supabase/migrations/20261120100000_reposicao_po_a_baixar_pares_e_decisao.sql`. Prova:
`db/test-reposicao-po-a-baixar-decisao.sh`. Sensor: `db/sensor-po-a-baixar.sql`.

## O que entrou

- **`reposicao_po_a_baixar_v2`** (aditiva — a v1 fica intocada; `DROP` da v1 é decisão do founder, fora do envelope):
  a fila da v1 + `pares` (os pares que a sombra já calculou, com o item do PO resolvido no `raw_data` do espelho),
  `pares_retidos`, `fornecedor_nome` nas NF pendentes, `chave`, `proposta_versao` e a decisão vigente do episódio.
  Lógica em `private._po_a_baixar_fila` (1 lugar, sem gate; quem chama gateia).
- **Sensor com denominador**: `reposicao_po_a_baixar_episodio` (1 linha por ENTRADA na fila, mesmo sem decisão) e
  `reposicao_po_a_baixar_decisao` (ledger append-only da declaração). Writers únicos; o dos episódios tem duas portas
  (cron horário `reposicao-po-a-baixar-episodios` + a RPC de decisão), serializadas por advisory lock por empresa.
- Card: tabela de pares, aviso de par retido, candidatos para ambígua, motivos traduzidos (todos os do classificador),
  botões por tipo (`encerrei` só PO, `associei` só NF). Sem link para o Omie (não há URL estável verificada).

## Decisões e por quê

- **Escrita fora da leitura.** Episódio NÃO é gravado dentro da RPC de leitura (STABLE e paginada — N execuções por
  abertura de tela) nem no edge da sombra (só conhece `nf_pendente`, exigiria deploy de edge).
- **Parecer Codex (challenge, 34 s, 40k tokens) aplicado:** episódio por entrada (reentrada não herda decisão);
  desfecho guarda FATOS, a interpretação ("confirmado") mora na query do sensor; lock nas duas portas; idempotência
  por `intencao` (uuid por clique, reusado no retry) + precondição `proposta_versao` (PB002); carga inicial
  estratificada (`origem = carga_inicial`, idade desconhecida — fora do tempo até resolução).
- **Par retido por PO encerrado (achado no ensaio contra a prod).** A sombra julga a etapa do PO pelo `raw_data`, que
  pode estar velho; `encerrado_omie_em` vem da passada de encerrados, mais nova. Em 2026-11-18 o ÚNICO par associável
  de prod (NF 000959992 → PO 1330) apontava para PO visto encerrado em 11/11. Precisão > recall: a v2 retém o par
  (`pares_retidos = 'po_encerrado_no_omie'`) e a tela avisa.

## Provas

- PG17: 28 asserts; `--falsificar` com controle verde na mesma invocação, em `LC_ALL=C` e com
  `HARNESS_LC=pt_BR.UTF-8`. **Não falsificado** (declarado): o advisory lock entre as duas portas (exigiria duas
  sessões concorrentes).
- vitest do card/núcleo; sabotagem da tabela de pares e da guarda de `proposta_versao` derrubam o teste delas.

## Como medir (a query, não recado)

`~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sensor-po-a-baixar.sql` — elegíveis, decididos, declarados,
verificáveis, confirmados por releitura, concordância (NULL com 0 declarações), declarados sem confirmação há > 7 d,
mediana/p90 até sair e até decidir, por empresa × tipo × origem. Piloto de escrita no Omie só com esse sinal.
