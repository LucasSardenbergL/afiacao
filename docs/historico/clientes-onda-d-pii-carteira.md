# Clientes — onda D: contato do cliente só na carteira (fatia 1 de 3)

**Decisão do founder (2026-11-24):** opção (c) — identidade aberta a staff; documento, telefone, e-mail e
endereço só na carteira/cobertura; gestor/master veem tudo; customer inalterado. Para as telas operacionais
que legitimamente precisam de PII fora da carteira: **contexto operacional** (RPC por OBJETO + ledger).
Spec: `docs/superpowers/specs/2026-11-24-clientes-pii-por-carteira-design.md` (Codex challenge integrado).

## Fatia 1 (este PR) — contrato, sem fechar nada
- Migration `20261124120000_clientes_pii_contrato_carteira.sql`:
  - `private.clientes_para_agir(uid)`: atribuição **elegível** expandida pela raiz fiscal; raiz com 2 donos
    elegíveis **não** expande (prod: 0 raízes ambíguas, 0 cadeias de alias em 2026-11-24).
  - `private.clientes_contato_visiveis` / `cliente_pode_agir` / `cliente_contato_visivel` (staff atual,
    gestão, carteira, cobertura vigente; **sem** o ramo "alvo é colega").
  - `public.pode_agir_no_cliente(uuid)`: o MESMO predicado na ficha (`AcoesDaFicha`) e no escritor
    (`venda_registrar_contato`, que aceitava atribuição não elegível; a ficha ignorava alias).
  - `public.v_perfil_contato`: view-gate (`invoker=off`, `barrier`) mascarada + `contato_visivel` + `eh_pj`.
  - `public.buscar_clientes_global`: Cmd-K — staff nunca aparece; doc/CNPJ/e-mail só casam onde visível
    (termo do contato oculto responde igual a termo ausente).
- Front: 360 lê contato pela view e diz "contato visível só para a carteira" (≠ vazio ≠ falha); Cmd-K pela
  RPC, erro visível, recentes por usuário só `kind/id/title/path` e a chave antiga `global_search_recents_v1`
  (que guardava CPF/CNPJ no subtitle) apagada.
- Prova: `db/test-clientes-pii-contrato-carteira.sh` (C **e** pt_BR.UTF-8; controle verde + 10 sabotagens).

## O que AINDA não vale (lacuna declarada, assert L1 do harness)
Pela API, o employee **ainda lê** PII de qualquer cliente direto de `profiles`/`addresses`/
`customer_contacts`, e pelas superfícies do mapa (customer_metrics_mv, sales_orders snapshot, views de
grupo/caça, `listar_clientes_base`, edges `omie-cliente`/`mcp`). Fecha na fatia 3, depois de a fatia 2
migrar os ~35 leitores (pedido, expedição, rota, aprovação → RPC operacional por objeto + ledger).

## Lições
- Com 3 staff e o master dono de 82% da carteira, "só na carteira" estrito quebraria pedido/rota/expedição
  da farmer — a exceção operacional é requisito, não afrouxamento. Medir a DISTRIBUIÇÃO de donos antes de
  desenhar autorização por carteira.
- Grant de coluna > RLS por linha para separar contato de identidade: leitor antigo quebra com 42501
  (visível) em vez de concluir que o cliente não existe (silencioso). Precedente: margem, 20261014120100.
