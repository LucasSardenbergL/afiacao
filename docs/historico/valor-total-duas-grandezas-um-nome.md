# `valor_total`: duas grandezas sob um nome só (2026-09-06)

Achado B2 do spec `2026-09-06-selo-preco-disparo-omie-design.md` §9.3. **Bug pré-existente**, deixado
fora do escopo do #2258 de propósito (separação de efeitos).

## O que era

`pedido_compra_sugerido.valor_total` carregava duas coisas semanticamente distintas:

- **derivado** — Σ(`pedido_compra_item.valor_linha`). É o que o gate de valor mínimo compara
  (`disparar-pedidos-aprovados/index.ts:358`), o que o e-mail ao fornecedor mostra, e o que
  corresponde ao payload do Omie (`nQtde × nValUnit`, item a item — **o Omie não recebe o total do
  cabeçalho**);
- **provado** — `data.value` do Efetivar do portal Sayerlack: o que o fornecedor cobrou.

Seis escritores, cinco do derivado (`reposicao_persistir_qtde_inteira`,
`remover_itens_pedido_sugerido`, `pedido_compra_split`, `aplicar_promocoes_no_ciclo`, a edição
inline do `PedidoRow`) e um do provado (`sayerlack_aplicar_custo_portal`). O provado sobrevivia por
acidente, e seu único rastro durável era `portal_resposta.captura_custo.checksum.total_json` — jsonb
multi-writer que o próprio código rotula "NÃO autoritativa". Exatamente o antipadrão do CLAUDE.md.

## O que a medição em prod disse (e o que ela NÃO disse)

- **Dano consumado: zero.** 13 envios `sucesso_portal` desde 01/09; só o #2459 tem resumo de captura,
  e ele registra `motivo=erro_rpc`, `cego=true`, `atualizados=0`. `sqlstate_rpc = PGRST202` — a
  função existia em `pg_proc`; o schema cache do PostgREST é que não a via.
- **"Nunca gravou" ≠ "o erro continua ativo"** (correção do Codex): o apply da função foi em 05/09,
  *depois* do #2459, e não houve envio desde. Compatível com o dado, mas não é prova.
- **As duas grandezas discordam de verdade:** no #2459, `total_json` 374,77 contra Σ(linhas) 387,83 —
  R$ 13,06 (3,37%), coerente com a divergência de 3,2510% em aberto (`captura-custo.ts` §24).
- Dois dos três pontos do relato original **não se sustentaram**: a recomputação do `ceil` roda
  **antes** do portal (passo a.2) e é condicional a `v_ajustados > 0`; e o gate de mínimo
  short-circuita por `PORTAL_JA_TOCADO` — que contém `sucesso_portal`, o próprio status que a RPC
  exige — antes de ler `valor_total`.

## Lições

1. **Trocar a coluna de destino não basta.** O desenho inicial (gravar o provado numa coluna nova e
   parar de tocar `valor_total`) deixaria o cabeçalho **obsoleto**: a RPC reescreve
   `preco_unitario`/`valor_linha` dos itens, então quem para de manter o derivado deixa-o descrevendo
   o mundo de antes. Com o #2459: `valor_total` 387,83 sobre itens somando 374,77. Quem assume a
   escrita de metade de um invariante assume a outra metade **na mesma transação**.
2. **Sensor pode ser cego por construção.** Comparar `valor_total_portal_provado` com Σ(linhas)
   *depois* da substituição não vê nada: com 1 item, `valor_linha = data.value` e o delta é zero por
   definição; com N itens divergentes, o checksum já recusou e nada foi gravado. Medir divergência
   exige preservar as duas evidências **antes** de uma sobrescrever a outra.
3. **Tolerância que segura o dano não é desenho, é sorte.** A barreira subcentavo vinha do checksum,
   não de intenção — e `derivarCustos` pula item por `round2(...) === round2(...)`, arredondado a
   centavos, enquanto o checksum soma o DOM em precisão cheia: o checksum valida o **DOM**, não o
   conjunto **persistido**.
4. **`ausente ≠ zero` tem endereço aqui:** `COALESCE(sum(valor_linha), 0)` sobre um pedido com item
   sem custo fabrica o número que o gate de mínimo lê. Virou `CP005`, fail-closed — nem o provado é
   gravado.
5. **Falsificação pega renomeação de variável.** Ao renomear `v_afetadas` → `v_atualizados` no passo
   2, a sabotagem F2 deixou de casar o padrão e o harness gritou "sabotagem NÃO casou — falsificação
   seria teatro" em vez de passar verde. É o guard funcionando.
6. **`/tmp` é compartilhado entre as ~34 worktrees.** Um `wt:preflight > /tmp/pf.log` recebeu no meio
   o 🔴 de *outra* sessão e quase virou um bloqueio inexistente. Redirecione para o scratchpad da
   sessão, e desconfie de relatório cujo veredito não bate com o corpo.

## Entrega

`20260906193522_valor_total_portal_provado.sql` — colunas `valor_total_portal_provado{,_em,_protocolo}`
(escritor único: a RPC) e `sayerlack_aplicar_custo_portal` reescrita: CAS → itens → **recálculo do
derivado sobre todos os itens persistidos**, tudo numa transação. Assinatura preservada, para que a
edge no ar continue funcionando entre o apply do banco e o deploy da edge. Prova:
`db/test-sayerlack-custo-portal-cas.sh` (PG17, 53 asserts, falsificação por defesa — F9 mata o
recálculo, F10 mata o CP005).
