# Venda R2 · Entrega 4 — "falta completar o sistema" (13/11/2026)

**O que entrega.** O founder confirma, numa fila só-master (aba **Sistemas** em `/admin/venda-cliente`), pares
tinta/verniz → catalisador/diluente. Só par **confirmado** vira sugestão `tipo='sistema'` em `venda_sugestao`: aparece
na ficha da farmer ("Falta completar o sistema") e no e-mail diário (linha própria no bloco do cliente). Desfecho
medido como os outros, pelo `venda_fechar_desfechos`.

Migration `20261113213317_venda_sistema_completo.sql` · prova `db/test-venda-sistema.sh` (63 asserts, `C` e
`pt_BR.UTF-8`, 17 sabotagens vermelhas com controle verde na mesma invocação; no núcleo de CI).

## Decisões (e o porquê)

- **Tabela dedicada `venda_sistema_par`, não `kb_catalisador_links`.** Aquela tem outro escritor
  (`confirmar_catalisador_vinculo`, módulo KB congelado) e outra semântica (código CITADO no boletim ↔ SKU do
  catalisador, 1 SKU por código). Aqui a chave é `(empresa, SKU-base, SKU-par)`. Escritor da decisão: só
  `venda_sistema_decidir` (master). A leitura da fila só INSERE o candidato mostrado (`pendente`) — é o denominador
  do sensor. Trilha `venda_sistema_par_decisao` append-only (trigger 55000).
- **Coocorrência só ORDENA.** Candidato = SKU de família-base e SKU de família catalisador/diluente no MESMO pedido
  (12m), com ≥ 3 pedidos juntos e ≥ 5% dos pedidos da base (corta "seladora nitro + catalisador PU" — ruído real em
  prod), no máx. 2 por base×papel e 30 por empresa, ordenado pelo R$ da base (o eixo da decisão). Famílias e cortes
  em `venda_config` (`sistema_familias`, `sistema_regras`) — o founder ajusta sem migration.
- **Boletim = dica, nunca decisão.** Spec aprovada cujo código a descrição da base CITA (fronteira dos dois lados:
  `DF.4068` ≠ `DFA.4068`). Mais de um boletim → "ambíguo" (ambiguidade ⇒ nenhuma ficha, `knowledge-base.md`).
  `omie_product_spec_links` tem 0 confirmados em prod — por isso o casamento por código na descrição, só como rótulo.
- **Quem recebe:** comprador da lista ATIVA de hoje (a ligação já vai acontecer) que comprou a base em 30 dias e não
  comprou NENHUM par confirmado daquele sistema (base×papel) em 90 dias. Outra embalagem confirmada (LT/QT/L5) suprime
  e, no desfecho, completa. Máx. 2 por cliente/dia; o mesmo par não repete dentro da janela (30 dias).
- **Grupo controle:** os dois braços geram (o trigger da Entrega 1 marca); a ficha, o e-mail e o `marcar_mostrada`
  já escondem o controle. O fechamento mede `sistema` como `recompra` (intenção de tratar): o controle nunca mostrado
  é `nao_virou`/`virou_pedido`, não `nao_exibida` — senão não haveria contrafactual.
- **Desligar na hora:** rejeitar um par confirmado tira a sugestão da ficha e do e-mail no mesmo instante (as duas
  leem `status='confirmado'` ao vivo), o gerador para de criá-la, e o fechamento fecha a aberta como
  `nao_medivel/par_revogado` (creditar "virou" sobre par errado seria fabricar resultado). `onda_sistema` é o
  desliga-tudo.

## Medido em prod (psql-ro, 13/11)

- `kb_catalisador_links`: 0 linhas. `kb_product_specs`: 119 aprovadas, 81 citam catalisador, 107 diluente.
- Candidatos: **Oben** 457 pares (145 com ≥ 3 pedidos juntos); **Colacor** 1 (vende lixa — o sistema é Oben). A fila
  da Oben sai em 1,2 s; topo: `FUNDO PU FL.6673.00LT → CATALISADOR FC.6975LT` em 62% dos pedidos da base.
- **Teto da oportunidade é baixo e é o diluente:** dos 33 compradores Oben de base PU em 30 dias, 2 sem nenhum
  catalisador e 8 sem diluente em 90 dias. Na lista diária (79–124 compradores), 12–17 compraram base PU em 30 dias e
  1–2 estão sem catalisador/diluente. Com os 3 pares de topo de catalisador confirmados, a simulação de 10 dias dá
  **0** sugestões (todos já levam o FC.6975LT). Esperar ≈ 1–4 sugestões/dia, concentradas em diluente.

## Sensor (`venda_sistema_sensor`, na aba)

1. confirmados ÷ candidatos mostrados, por empresa;
2. sistemas completos ÷ pedidos elegíveis (pedido com a base de um par confirmado hoje; completo = o mesmo pedido
   levou um par confirmado daquele sistema), por braço;
3. sugestões `sistema` por braço: geradas, mostradas, viraram, não viraram, não medível.

**Quando medir (query, não recado):** `SELECT public.venda_sistema_sensor(current_date - 30, current_date)` como
master — fase N+1 (ex.: ligar para quem não está na lista) só com `confirmados > 0` E sugestões maduras nos dois braços.

## Limites conhecidos

- Pares são por SKU: confirmar o catalisador LT não confirma o QT. A fila mostra as embalagens frequentes; a rara
  (1 pedido junto) não aparece — o founder pode confirmar depois quando ela cruzar o corte.
- `qtd_ref`/`valor_ref` da sugestão `sistema` são NULL (ausente ≠ zero): não há base honesta para a quantidade.
- O e-mail só traz o sistema dos clientes que já estão no resumo (top-8 do ranking de recompra).
