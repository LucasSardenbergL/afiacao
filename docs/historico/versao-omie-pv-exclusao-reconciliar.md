# Changelog do `VERSAO` — edge `omie-pv-exclusao-reconciliar`

Cada bump novo acrescenta aqui (o `versao.ts` fica curto — gate `limpeza-fonte`).

```text
v1.0 (2026-11-21) — nasce: baixa automática de PV EXCLUÍDO direto no Omie (cron de hora em hora). Por conta, em série:
execução presa à identidade da credencial (hash da app_key) e à cadência de 50 min; triagem por ListarPedidos com
filtrar_apenas_inclusao S (semana corrente + 1 semana de cursor até 2024-01-01), 100 por página, ≤ 6 chamadas/h
pedidas ao banco, presença registrada por página; ≤ 1 ConsultarPedido/h e ≤ 4 tentativas cobradas/24h concedidas pelo
banco; 1º 425 registrado na trava compartilhada e a conta para. A baixa (deleted_at + reserva liberada com trilha) é
da RPC omie_pv_consulta_registrar na 2ª ausência afirmada. Registro em acoes_execucoes, slug vendas.pv_excluido_omie.
```
