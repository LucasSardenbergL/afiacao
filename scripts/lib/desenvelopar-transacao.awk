# Remove UM `BEGIN;` inicial e UM `COMMIT;` final do corpo — e RECUSA qualquer outra forma.
# Rastreia dollar-quoting ($tag$) para não confundir o `BEGIN` do PL/pgSQL, que vem sem `;`.
BEGIN { dq=0; nb=0; nc=0; outros=0; primeira=0; ultima=0; n=0 }
{
  linha[++n] = $0
  s = $0
  sub(/--.*$/, "", s)                       # comentário de linha
  gsub(/[ \t]+$/, "", s); gsub(/^[ \t]+/, "", s)
  tmp = $0
  while (match(tmp, /\$[A-Za-z_0-9]*\$/)) { dq = 1 - dq; tmp = substr(tmp, RSTART+RLENGTH) }
  if (dq != 0) next                          # dentro de bloco dollar-quoted: ignora
  u = toupper(s)
  if (u == "BEGIN;")  { nb++; if (primeira==0) primeira=n; else outros++ }
  else if (u == "COMMIT;") { nc++; ultima=n }
  else if (u ~ /^(ROLLBACK|SAVEPOINT|START TRANSACTION)/) { outros++ }
  else if (s != "") { if (primeira==0) primeiraNaoVazia=n }
}
END {
  if (nb==0 && nc==0) { for (i=1;i<=n;i++) print linha[i]; exit 0 }        # nada a fazer
  if (nb!=1 || nc!=1 || outros>0) { print "RECUSA" > "/dev/stderr"; exit 3 }
  if (primeira > primeiraNaoVazia && primeiraNaoVazia>0) { print "RECUSA" > "/dev/stderr"; exit 3 }
  for (i=1;i<=n;i++) if (i!=primeira && i!=ultima) print linha[i]
}
