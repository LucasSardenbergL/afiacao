# Orçamento de compra v1 — backtest (2026-10-15)

Projeto 2 do programa "ciclo financeiro de compras". A v1 é **só simulação offline**: nenhuma tela, nenhuma migration, nenhuma edge, nenhum Publish. O app não muda.

- Spec: `docs/superpowers/specs/2026-10-15-orcamento-compra-design.md` (#3095) · plano: `docs/superpowers/plans/2026-10-15-orcamento-compra.md`
- Núcleo puro: `src/lib/reposicao/orcamento-compra/` (datas, embalagens, demanda, valor, caixa, camadas, corte, replay, medição)
- Backtest e página: `scripts/orcamento-compra/{simular,pagina}.ts` · fatos: `docs/superpowers/orcamento-compra/fatos.sql` (psql-ro, `ON_ERROR_STOP` + `fim|ok`) · como rodar e números: `docs/superpowers/orcamento-compra/LEIA-ME.md`

## O que entrega

O teto de compra tem duas condições. A primeira é a reserva mínima diária de caixa em 91 dias, com cenário-guarda sem venda nova. A segunda é o gate econômico ΔV>0 por embalagem incremental. O backtest roda os ciclos do motor dos últimos 90 dias e faz um replay contrafactual do estoque. Mede a precisão por episódio de corte e o ΔDIO. Um **portão** re-executável (`avaliarPortao`) diz se a v2, que aplica no app, pode começar.

## Resultado (repo público: só relativos; absolutos no Artifact privado)

**Portão FECHADO.**
- Precisão por episódio de 84,9%, com cobertura de 19,1%.
- 264 de 268 ciclos com caixa indeterminado. A causa são 13 pedidos de maio/junho sem NF no tracking, que somam ~7% do pedido do motor. O founder decidiu manter o indeterminado (fail-closed), e investigar esses pedidos fica para a próxima fatia.
- Sem a guarda de caixa, o gate econômico aceitaria ~47% do que o motor pediu.

## Codex (money-path), duas consultas

1. **Desenho:** reprovou o desenho inicial. Os achados P0/P1 estão incorporados na spec, §9.
2. **Adversarial do diff:** 0 P0, 10 P1 e 5 P2, todos aceitos (R32–R46). O achado principal foi que o replay isolado por embalagem aprovava cortes que, juntos, rompem o estoque. Com remoção conjunta e chegada real, a precisão caiu de 100% para 84,9%.

## Lições

- **Ausência de ruim ≠ bom (R36/R55):** um portão que abre porque "não há inviável" deixava passar ciclos indeterminados, uma lista vazia ou um estado desconhecido. Agora ele exige pelo menos 1 ciclo e todos viáveis.
- **"Existe no CP" ≠ "pago" (R35/R38):** o título só desconta o compromisso se estiver representado no snapshot ou liquidado antes dele. Corte por idade não liquida dívida.
- **Medir o mesmo corte que se aplica (R32/R33):** remover embalagem por embalagem, na chegada mediana, mede outro corte.
- O ledger de decisões (R1–R56) ficou no workspace SDD, que não é versionado. As decisões que valem estão nas premissas (`PREMISSAS` em `simular.ts`) e no LEIA-ME.

## 2026-10-16 — os 13 pedidos sem NF (R57/R58)

- **Causa-raiz:** NF órfã no tracking. A edge casa NF↔pedido por `nNumPedCompra` = `cContrato`; NF que chega antes da linha do pedido vira órfã e nunca é reconciliada (25 vínculos recuperáveis no dia). A correção na fonte é de outra sessão.
- **Lição (Codex xhigh):** "ligar a NF pelo contrato" fabrica liquidação quando o pedido tem **outro** identificador Sayerlack sem NF — os reenvios ao portal de 22/05 criaram um 2º pedido na Sayerlack para o mesmo pedido Omie. Regra: todo identificador do pedido precisa de NF. E "pedido refeito com os mesmos itens" não prova substituição se o contrato do manual pertence a um pedido do motor (1037 = 1048).
- **Lição (Codex xhigh):** filtrar o título as-of não basta — a topologia NF↔pedido também carrega o futuro. A NF vinculada só vale se faturada antes do dia do ciclo.
- **Resultado:** com as regras endurecidas, só 1 dos 13 ganha NF e o portão segue fechado. O que destrava é evidência do portal (status dos reenvios 2096768–2096771 e do 2094267), não regra nova.

## 2026-10-18 — pedido encerrado no Omie sai do caixa (R59)

- **Problema:** pedido disparado e cancelado no portal (1014, 1049) seguia como compromisso sem NF e deixava o ciclo indeterminado. O Omie não mostra o encerramento no cabeçalho (`cEtapa="15"` em aberto e em encerrado, inclusive no webhook `CompraProduto.Encerrada`).
- **Fonte:** a `omie-sync-pedidos-compra` v1.5 faz uma passada só com `lExibirPedidosEncerrados` e registra o conjunto pela RPC `reposicao_registrar_encerrados_omie`, que é o único writer de `encerrado_omie_em` e de `reposicao_encerrados_omie_publicacao`. A migration é `20261018092000`.
- **Lição (Codex challenge xhigh, 6 P1):** um filtro não provado não pode publicar no 1º run, e o controle negativo tem de impedir a publicação. Daí o modo observado com `habilitado` ligado à mão. Também entraram o fencing por seq da coleta, a coluna igual ao conjunto atual (marca sem cobertura não sobrevive) e a regra de que ausência de vínculo R57 não prova ausência de NF.
- **Falsificação:** a camada "vínculo R57" ficou verde quando sabotada, porque a checagem de identificadores já cobre o vínculo por contrato. Só o substituto R58 precisa dela, e ganhou teste.
