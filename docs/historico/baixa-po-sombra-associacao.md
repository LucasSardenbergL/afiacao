# Baixa de PO — proteção do motor e sombra da associação NF↔PO (2026-10-16 a 18)

> PRs [#3116](https://github.com/LucasSardenbergL/afiacao/pull/3116) (`omie-sync-estoque` v1.10) e
> [#3124](https://github.com/LucasSardenbergL/afiacao/pull/3124) (`omie-sync-nfes-recebidas` v1.6 + migration
> `20261017040000_recebimento_associacao_sombra.sql`) · spec
> `docs/superpowers/specs/2026-09-26-baixa-pedido-compra-nf-concluida-design.md` §18.

## Pedido

Founder, 2026-10-17: "caso uma NF tenha sido concluída, temos que ter certeza que o respectivo pedido de compra deva ser
encerrado total caso todos os itens tenham sido faturados e parcial caso falte algum." A API do Omie não encerra PO; o
total × parcial nativo é a **associação** item da NF ↔ item do PO (`AlterarRecebimento`, `ASSOCIAR-PEDIDO`). Decisões:
associação nativa · sombra + piloto antes de escrever · quantidade exata · órfã/duplicidade/item sem par → fila humana.

## O que entrou

- **#3116 — proteção do motor (PR(d)).** PO em etapa desconhecida com saldo recusa o run do `omie-sync-estoque` inteiro
  (o par físico/pendente anterior fica). Pré-requisito: a associação parcial leva o PO para fora da etapa 15, e sem a
  recusa o motor passaria a subcontar o "a caminho" em silêncio.
- **#3124 — sombra.** Para cada NF detalhada, classifica a associação (`associavel` com pares e cobertura total/parcial
  por PO · `ambigua` · `orfa` · `ja_vinculada` · `fora_de_alcance`, sempre com `motivos`) e publica em
  `recebimento_associacao_sombra` (1 writer: RPC `SECURITY DEFINER` com compare-and-set por `observado_em`). Nada vai ao
  Omie. Roda numa **fase depois** do vínculo, da reconciliação e do backfill de todas as empresas; os POs da fila são
  capturados **antes** do backfill, sob um teto único de 8 s.

## O que o desenho não previa (e quem pegou)

| defeito | quem pegou | como |
|---|---|---|
| flags da NF lidas em `cabec` — toda NF pendente real sairia "ilegível" | Codex 1ª rodada (P1) | formato **medido** em 84 detalhes reais via `psql-ro`: flags em `infoCadastro`, pendente = `cEtapa` 40 |
| `nIdItPedido` ausente tratado como desconhecido | medição | ausente em 199/199 itens de NF pendente e positivo em 206/206 de concluída → ausente = sem vínculo; presente e torto = ilegível |
| sombra no laço comia o orçamento do vínculo das próximas NFs | Codex 1ª (P1) | fase posterior + `completeSync` no `finally` |
| carimbo antes dos retries deixava um cancelamento mais novo perder o compare-and-set | Codex 2ª (P2) | `aoTentar` antes do `fetch` de cada tentativa |
| backfill trocava o `raw_data` do PO pelo recebimento antes da fase | Codex 2ª (P2) | captura dos POs antes do backfill |
| captura sem teto acumulado (8 s por lote) | Codex 3ª (P2) | um `AbortSignal` para a captura inteira; interrompida não anexa mapa parcial |
| laço `--falsificar` aprovava ausência de VERMELHO | Codex 1ª (P2) + gate `falsificar-exige-assert` | idioma `SABOTAGENS` com `ID!MARCA`, exige VERDE explícito e RESUMO |

Codex aprovou na 4ª rodada (P1 0 · P2 0 · P3 0). Provas: Deno 55/55 com 35 sabotagens vermelhas; PG17 20/20 em `C` e
`pt_BR` + 13/13 sabotagens.

## Deploy (2026-10-18, pela sessão)

- Migration pelo envelope do MCP: ensaio com `RAISE 'ENSAIO_OK'` (rollback conferido por `psql-ro`), depois a real com
  checagem extra `md5(prosrc)` contra o arquivo; 2ª testemunha `psql-ro` ✅.
- Edge pelo `send_message` do Lovable (Passo 2 verbatim, 16/16 hashes, 1,6 crédito). O `lovable-sensor-edicao` deu
  `EDICAO_DETECTADA` só porque a resposta trazia `commit_sha` — o commit apontado regenerou apenas `types.ts` (tolerado).

## Medição em prod

- O cron do `sync-nfes` passa `dias=3` (por emissão): NF mais velha que isso não é revisitada. As duas NFs pendentes
  Sayerlack (000955263 e 000955580) foram lidas por **um** disparo pontual (OBEN, Sayerlack, 13–16/10, `net.http_post`
  com o segredo do vault): ambas `ambigua`.
  - 000955263: `item_sem_par` + `quantidade_menor_que_saldo` (entregas parciais legítimas + 1 SKU fora de PO);
  - 000955580: `produto_ilegivel` (item sem produto Omie) + `quantidade_ilegivel` (conversão L → embalagem com 6 casas).
- Piloto D4' real escolhido pelo founder em 2026-10-18: a equipe associa e conclui a 000955263 no Omie (3 POs total, 3
  parcial). Roteiro, foto do antes e resultado: spec §18.
