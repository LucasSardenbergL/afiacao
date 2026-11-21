# Changelog do `VERSAO` — edge `omie-cliente-trocar-vendedor`

Cada bump novo acrescenta aqui (o `versao.ts` fica curto — gate `limpeza-fonte`).

```text
v1.0 (2026-11-20) — nasce (Meu dia do CEO, leva 2): troca em lote o vendedor do cadastro do cliente no Omie
(AlterarCliente, só recomendacoes.codigo_vendedor, com o objeto recomendacoes inteiro). Lotes: saida_vendedora
(6 códigos da Tatyana → Regina na mesma conta) e orfaos (sem vendedor → Regina/Lucas por escolha do founder).
Modos dry_run/aplicar/verificar; origem e alvo constantes em decisao.ts; alvo conferido ativo no ListarVendedores;
pré-condição lida no Omie (ConsultarCliente); releitura por ListarClientes (o Omie recusa repetir a mesma chamada em
<60s) e hash do cadastro sem vendedor/info ≥61s depois. Recibo por cliente em omie_cliente_vendedor_troca; espelho
omie_customer_account_map por UPDATE estreito (a RPC register_carteira_member zeraria a evidência do vínculo).
Gate authorizeCronOrStaff; ação só master/service_role/cron-secret; sem cron agendado.
```

## v1.1-payload-com-estado (2026-11-21)

- **Medido no canário (8 clientes, 3 contas):** o AlterarCliente recusou TODOS com `É obrigatório o preenchimento do endereço (Estado)` — o payload só com `codigo_cliente_omie` + `recomendacoes` não basta. A releitura provou "nada gravado" em todos (fail-safe funcionou).
- **Correção:** `payloadAlterar` reenvia `estado` (e `cidade`, se houver) EXATAMENTE como o ConsultarCliente devolveu; o hash da verificação ≥61s prova que não mudaram. Cadastro sem `estado` → `precondicao_falhou` (“cadastro sem estado no Omie (o AlterarCliente exige)”), sem escrever — inclusive no dry_run.
- O fake do Omie nos testes passou a recusar payload sem `estado`, como o real. Falsificado: 4 sabotagens vermelhas com controle verde na mesma invocação.
