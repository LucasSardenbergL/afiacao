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
- **Correção:** `payloadAlterar` reenvia `estado` EXATAMENTE como o ConsultarCliente devolveu; o hash da verificação ≥61s prova que não mudou. `cidade` NÃO vai (Codex v1.1 P2: reenviar o nome lido poderia desfazer uma correção de município concorrente sem o hash acusar) — se o Omie passar a exigir, o canário mostra. Cadastro sem `estado` → `precondicao_falhou` (“cadastro sem estado no Omie (o AlterarCliente exige)”), sem escrever — inclusive no dry_run.
- **Codex v1.1 P2 (preexistente):** o modo `verificar` agora PARA (`parou` preenchido, `fim=false`) ao achar `divergente` — antes podia anunciar fim.
- O fake do Omie nos testes passou a recusar payload sem `estado`, como o real. Falsificado: 6 sabotagens vermelhas com controle verde na mesma invocação.

## v1.2-payload-com-endereco (2026-11-21)

- **Medido no 2º canário (v1.1, mesmos 8 clientes):** com só `estado`, o Omie recusou todos com `É obrigatório o preenchimento do endereço (Endereço, Número, Bairro, Cidade, Estado e CEP)`; releitura provou "nada gravado" em todos. O AlterarCliente valida o BLOCO de endereço inteiro.
- **Correção:** `payloadAlterar` reenvia `endereco`, `endereco_numero`, `bairro`, `cidade`, `estado`, `cep` EXATAMENTE como o ConsultarCliente devolveu (nada além disso). Qualquer um vazio → `precondicao_falhou` ("endereço incompleto no Omie (o AlterarCliente exige): falta …"), sem escrever, inclusive no dry_run.
- **Risco aceito** (o Codex v1.1 P2, agora forçado pelo Omie): uma correção de endereço feita por alguém na janela de ~1s entre o Consultar e o Alterar seria desfeita sem o hash acusar.
- Falsificado: 4 sabotagens vermelhas (sem cep, sem pré-condição, só estado, branco aceito) com controle verde no início e no fim.
