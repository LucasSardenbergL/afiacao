#!/usr/bin/env bash
# Falsificacao: cada guarda do claude-mem-reanimar.sh e sabotada UMA por vez.
# Para cada uma, na MESMA invocacao: controle (script original) tem de ficar VERDE
# e o sabotado tem de ficar VERMELHO no cenario que vigia aquela guarda.
# Sed que nao muda o arquivo = teatro (conta como problema).
# Uso: python3 subreaper.py bash falsifica.sh
set -u
L="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ORIG="$L/../claude-mem-reanimar.sh"
BOAS=0; PROBLEMAS=0

sabota() { # $1 nome · $2 cenario · $3 expressao sed
  local nome="$1" cen="$2" expr="$3" alvo="$L/sabotado-$1.sh" c s
  cp "$ORIG" "$alvo"
  sed -i "$expr" "$alvo"
  if cmp -s "$ORIG" "$alvo"; then
    echo "[$nome] TEATRO: o sed nao mudou nada"; PROBLEMAS=$((PROBLEMAS + 1)); return
  fi
  SCRIPT="$ORIG" bash "$L/lab.sh" "$cen" >"$L/fals-$nome-controle.txt" 2>&1; c=$?
  SCRIPT="$alvo" bash "$L/lab.sh" "$cen" >"$L/fals-$nome-sabotado.txt" 2>&1; s=$?
  if [ "$c" = 0 ] && [ "$s" != 0 ]; then
    echo "[$nome] ok — controle verde, sabotado vermelho: $(grep -m1 'FALHA' "$L/fals-$nome-sabotado.txt" | sed 's/^ *//' | cut -c1-90)"
    BOAS=$((BOAS + 1))
  else
    echo "[$nome] PROBLEMA — controle rc=$c, sabotado rc=$s"; PROBLEMAS=$((PROBLEMAS + 1))
  fi
}

sabota ordenacao-lexicografica c_saudavel 's/sort -t\. -k1,1nr -k2,2nr -k3,3nr/sort -r/'
sabota ignora-orphaned-at       c_saudavel 's|\[ -e "\$CACHE/\$v/.orphaned_at" \] \&\& continue|true|'
sabota porta-alheia-vira-nossa  c_alheio   's/^  return 1$/  return 0/'
sabota arvore-so-a-raiz         c_surdo_sim 's/alvo\[r\]=1; mudou=1/alvo[r]=1; mudou=0/'
sabota confirmacao-ignorada     c_surdo_nao 's/\*) return 1 ;; esac/*) return 0 ;; esac/'
sabota so-olhar-ignorado        c_so_olhar 's/\[ "\${1:-}" = "--so-olhar" \] \&\& SO_OLHAR=1/true/'
sabota sem-guarda-subindo       c_subindo  's/-lt 60 \]/-lt 0 ]/g'
sabota prova-frouxa             c_hook_falha 's/^if \[ "\$HRC" = 0 \] \&\& .*then$/if true; then/'
sabota curl-quebrado-vira-surdo c_nao_sondei 's/    \*) echo nao-sondei ;;/    *) echo surdo ;;/'
sabota sonda-ignora-host        c_host_config 's|http://\$HOST:\$PORT\$1|http://127.0.0.1:$PORT$1|'
sabota sem-trava-incoerente     c_incoerente 's/^  if \[ -n "\$DONOS" \]; then$/  if false; then/'

echo
echo "FALSIFICACAO: $BOAS guardas provadas · $PROBLEMAS problema(s)"
[ "$PROBLEMAS" = 0 ] && echo "FALSIFICACAO-VERDE" || echo "FALSIFICACAO-VERMELHA"
[ "$PROBLEMAS" = 0 ]
