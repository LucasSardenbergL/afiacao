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

## v1.3-payload-com-escalares (2026-11-21)

- **Medido no 3º canário (v1.2, mesmos 8):** com o endereço completo, o Omie recusou todos com `É obrigatório o preenchimento do e-mail`; releitura provou "nada gravado". Conclusão: o AlterarCliente valida os campos OBRIGATÓRIOS da conta contra o PAYLOAD (não contra o cadastro gravado) — campo a campo seria um ciclo sem fim.
- **Correção:** o payload leva TODOS os campos ESCALARES (texto/número/booleano finito) do cadastro EXATAMENTE como o ConsultarCliente devolveu + `recomendacoes` com só o vendedor trocado. Listas/objetos (tags, caracteristicas, dadosBancarios, enderecoEntrega, info) NÃO vão (semântica de substituição no Omie; omitidos ficam como estão). Pré-condição de endereço completo mantida.
- Cadastro com campo obrigatório vazio no próprio Omie (ex.: sem e-mail) → o Omie recusa → `erro_omie` provado pelo hash, e o bloco segue.
- Risco aceito (o mesmo da v1.2, agora em todos os escalares): edição concorrente na janela ~1s entre Consultar e Alterar seria desfeita sem o hash acusar.
- Falsificado: 3 sabotagens vermelhas (volta à v1.2, manda listas/objetos, null/NaN passam) com controle verde no início e no fim.
- **Codex v1.3:** sem P1 de código. P1 OPERACIONAL acatado: antes do lote, o canário tem de incluir cadastros com listas/objetos PREENCHIDOS (tags, caracteristicas, enderecoEntrega, dadosBancarios) e exigir `verificado` — a resposta agora traz `blocos` por cliente para escolher esse canário. P2 acatados: `separar_endereco`/`pesquisar_cep` (instruções ao Omie) nunca vão; fault com vendedor inalterado responde `indeterminado` até a prova (antes dizia `erro_omie` sem prova quando faltava tempo). P2 recusado: pôr `info` no hash (dInc/cImpAPI) — o Omie pode mexer nesses metadados ao alterar via API e TODO cliente pararia como divergente; não é dado de negócio. Risco aceito: edição concorrente de `bloquear_faturamento`/`valor_limite_credito` na janela ~1s.

## v1.4-sem-vazios-e-diff (2026-11-21)

- **Medido no canário 4 (v1.3):** 6 recusas provadas sem gravação por texto VAZIO reenviado em campo com domínio (`tag [tipo_atividade] incorreto`, `tag [bloqueado] deve ser 'S' ou 'N'`); 1 escrita ACEITA (colacor_sc 3545069485, PROJET) com vendedor → Regina e o hash ≥61s acusando `divergente` sem dizer o campo. O "Histórico de Alterações" do Omie desse cliente mostra SÓ "Vendedor Padrão → REGINA" (founder conferiu) — o campo que mudou não aparece no histórico do Omie (provável metadado interno da alteração via API).
- **Correção:** texto vazio (ou só espaços) não vai no payload. Na divergência, `camposDiferentes` (mesmo recorte do hash: sem info/vendedor) grava no erro do item e do recibo QUAIS campos mudaram, de → para (≤20 caminhos, valores ≤60 chars).
- Falsificado: 3 sabotagens vermelhas (vazio volta, diff some, diff conta info) com controle verde no início e no fim.
- **Codex v1.4:** sem P1. P2 acatados: o diff só mostra VALOR em campos de controle (flags/códigos/cidade/tags/recomendações) — dado pessoal/bancário aparece só como `alterado|adicionado|removido`; divergência só de vendedor (hash bate) diz `vendedor esperado X, lido Y`. P2 adiado: diff no modo `verificar` (o cadastro de antes não persiste entre chamadas; exigiria assinatura por campo com HMAC) — o diagnóstico do canário acontece dentro do bloco. Falsificado +2 (valor pessoal vaza, vendedor-só mal dito).

## v1.5-amp-tolerado (2026-11-22)

- **Medido no lote 1 (v1.4, 1º bloco das 3 contas):** 5 `divergente` com `razao_social: alterado` (oben 8689681515, colacor 393821747/393821802/393822107, colacor_sc 3545069324; + PROJET colacor_sc 3545069485 do canário v1.3). Causa confirmada pelo founder no Histórico do Omie (colacor 393821802): o cadastro estava gravado com ENTIDADE HTML (`&amp;`); o ConsultarCliente devolve a entidade, a tela mostra `&`; reenviado como lido, o próprio Omie gravou o texto DECODIFICADO (razão social, nome fantasia, observações). Valor exibido idêntico — normalização, não dano. Os 6 ficam como estão (vendedor já é a Regina).
- **Correção:** o payload continua indo COMO LIDO (o Omie é quem normaliza). No recorte do hash/diff, nos DOIS lados, `&amp;` → `&` (literal, uma passada) SÓ em `razao_social`, `nome_fantasia`, `observacao`, `obs_detalhadas` (`CAMPOS_AMP_TOLERADO`). Qualquer outra mudança — `&` sumido, `&lt;`→`<`, quebra de linha, entidade numérica, e `&amp;`→`&` em identificador/endereço/tag — continua acusando `divergente` (para o bloco).
- **1º desenho descartado (Codex v1.5 P1):** decodificar TODAS as entidades em todo texto (payload + hash) cegava o verificador para mudança em identificador (`codigo_cliente_integracao = "ERP-&#49;"` → `"ERP-1"` daria `verificado`) e em blocos omitidos (tags). P2 junto: decodificar no payload furava a checagem de vazio (`&#32;`). Restrito ao medido.
- **Compatibilidade:** `hash_antes` gravado pela v1.4 de cadastro com `&amp;` nesses 4 campos não bate com uma releitura sob v1.5 sem mudança (acusa `divergente` — direção segura). Sem `&amp;` nesses campos, hash idêntico nas duas versões. Não há recibo v1.4 `alterado` pendente (o `indeterminado` restante é a SUPERFOGOS do canário v1.3, depois `verificado` em outra execução).
- Falsificado: sabotagens vermelhas (tolerância removida, tolerância em todo campo, decode de toda entidade, payload decodificado) com controle verde no início e no fim.
- **Codex v1.5 r2:** sem P1. P2 não acatado: a tolerância é simétrica (`&`→`&amp;` também passa) — o hash compara lado a lado, sem direção; as duas grafias exibem o MESMO texto na tela do Omie, então não há dano de negócio a esconder. P3 não acatado: as duas chaves de observação ficam (o pior caso é tolerar `&amp;`↔`&` num texto de exibição).
- **Risco a medir no canário:** `observacao`/`obs_detalhadas` são os nomes da API para "Observações" — se o Omie normalizar outro campo, o bloco para em `divergente` e o diff nomeia o campo.

## v1.6-texto-decodificado-e-reparo (2026-11-22)

- **A premissa da v1.5 era FALSA.** O canário v1.5 (colacor 393823340, exec `e422b489`) deu `divergente`. Um ConsultarCliente de leitura mostrou `ODMAR &amp;amp; ODILEY…`, e os divergentes da v1.4 estão iguais (393821802 `TRES R MOVEIS &amp;amp; CIA LTDA`; observação `d&amp;apos;água`, que era `d&apos;água`). **O Omie CODIFICA a entrada de texto** (`&`→`&amp;`, `'`→`&apos;`, estilo htmlspecialchars). Reenviar o texto como lido gravou entidade DUPLA: dano, não normalização.
- **Correção:** cada texto escalar vai decodificado UMA vez (`&amp; &lt; &gt; &quot; &apos;`, literal, uma passada: o inverso exato). O Omie recodifica e grava o original, e o hash compara LITERAL. A tolerância da v1.5 saiu.
- **Pré-condição nova:** um texto que o Omie regravaria diferente (`codificar(decodificar(s)) ≠ s`: `&`/`'` crus, entidade fora das 5) dá `precondicao_falhou` sem AlterarCliente, nomeando só o campo.
- **Lote `reparo_entidades`:** lista FECHADA no código (`REPARO_ENTIDADES`) com os 7 cadastros que a v1.3–v1.5 gravaram com entidade dupla: oben 8689681515; colacor 393821747, 393821802, 393822107, 393823340; colacor_sc 3545069324, 3545069485. Só toca quem já está no alvo (Regina). Envia o texto decodificado DUAS vezes; o esperado na releitura é o lido com uma camada a menos. O recibo guarda o hash ESPERADO, para o `verificar` nunca chamar de `verificado` um "nada gravado".
- **Limite conhecido:** no reparo, um fault do Omie (nada gravado) aparece como `divergente`, não `erro_omie`, porque o vendedor já era o alvo e só o hash distingue. É a direção segura.
