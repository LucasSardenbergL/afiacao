# Changelog do `VERSAO` — edge `sayerlack-encerrar-cancelado-portal`

Cada bump novo acrescenta aqui (o `versao.ts` fica curto — gate `limpeza-fonte`).

```text
v1.0 (2026-11-08) — nasce (Onda 5A fatia 2, item 5.3): botão "Encerrar — cancelado no fornecedor". Só master (JWT
humano; service_role só sonda). Recusa cedo pelas regras da RPC (inclusive pendência de disparo de qualquer idade);
consulta dirigida ConsultarPedCompra por AFI-<id> — só o fault que nega O PEDIDO e cita o código vira "ausente",
PO devolvido = recusa, o resto = indeterminado (nada muda); RPC sayerlack_encerrar_cancelado_no_portal revalida sob
FOR UPDATE, confere o espelho (AFI-<id> e contrato) e grava a trilha imutável. Registro em acoes_execucoes, slug
reposicao.encerrar_cancelado_portal.
```
