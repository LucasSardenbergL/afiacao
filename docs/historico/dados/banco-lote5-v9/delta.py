#!/usr/bin/env python3
"""Delta entre duas leituras de leitura-24h.sql (T0 e T1). Só lê arquivos locais.
Uso: python3 -I delta.py leitura-T0.out leitura-T1.out [--descontar tabela=blocos ...]

--descontar subtrai leituras CONHECIDAS e atribuíveis a consultas da própria sessão de diagnóstico
(registradas em descontos.txt), do heap da tabela e dos totais de blks_read.
"""
import sys
from datetime import datetime

BLOCO = 8192


def i(x):
    return int(x) if x.strip() else 0


def ler(path):
    d = {"TS": None, "DB": None, "WAL": None, "BG": None, "CK": None, "IO": {}, "T": {}, "S": {}, "I": {}, "IX": {}}
    fim = False
    for linha in open(path, encoding="utf-8"):
        linha = linha.rstrip("\n")
        if linha == "#FIM-OK":
            fim = True
            continue
        p = linha.split("|")
        k = p[0]
        if k == "TS":
            d["TS"] = datetime.fromisoformat(p[1])
        elif k in ("DB", "WAL", "BG", "CK"):
            d[k] = [i(x) if x.lstrip("-").isdigit() or not x.strip() else x for x in p[1:]]
        elif k == "IO":
            d["IO"][(p[1], p[2], p[3])] = [i(x) for x in p[4:]]
        elif k in ("T", "S"):
            d[k][p[1]] = [i(x) for x in p[2:]]
        elif k == "I":
            d["I"][p[1]] = [i(x) for x in p[2:]]
        elif k == "IX":
            d["IX"][p[1]] = [i(x) for x in p[2:]]
    if not fim:
        sys.exit(f"{path}: sem #FIM-OK")
    return d


def mib(blocos):
    return blocos * BLOCO / 1048576


def main(a, b, descontos):
    t0, t1 = ler(a), ler(b)
    desc_total = sum(descontos.values())
    horas = (t1["TS"] - t0["TS"]).total_seconds() / 3600
    print(f"janela: {t0['TS']} -> {t1['TS']} UTC = {horas:.2f} h")
    d0, d1 = t0["DB"], t1["DB"]
    rd, ht, tb = d1[0] - d0[0], d1[1] - d0[1], d1[2] - d0[2]
    if desc_total:
        print(f'(bruto: blks_read {rd}; descontado {desc_total} blocos de consultas do diagnóstico)')
        rd -= desc_total
    print(f"pg_stat_database: blks_read {rd} ({mib(rd):.0f} MiB, {mib(rd)/horas:.0f} MiB/h) | blks_hit {ht} | hit% {100*ht/(ht+rd):.3f} | temp_bytes {tb} | temp_files {d1[3]-d0[3]} | xact {d1[6]-d0[6]}")
    w0, w1 = t0["WAL"], t1["WAL"]
    print(f"WAL: records {w1[0]-w0[0]} fpi {w1[1]-w0[1]} bytes {(w1[2]-w0[2])/1048576:.0f} MiB ({(w1[2]-w0[2])/1048576/horas:.1f} MiB/h)")
    c0, c1 = t0["CK"], t1["CK"]
    print(f"checkpointer: timed {c1[0]-c0[0]} req {c1[1]-c0[1]} buffers_written {c1[2]-c0[2]}")
    print("\npg_stat_io (delta, reads/writes/hits/evictions/extends, MiB lidos/escritos):")
    for ch in sorted(t1["IO"]):
        v1, v0 = t1["IO"][ch], t0["IO"].get(ch, [0] * len(t1["IO"][ch]))
        dv = [x - y for x, y in zip(v1, v0)]
        if dv[0] or dv[2] or dv[1]:
            print(f"  {ch[0]:<20} {ch[1]:<14} {ch[2]:<10} reads={dv[0]} ({dv[0]*BLOCO/1048576 if ch[1]!='wal' else 0:.0f} MiB) writes={dv[2]} hits={dv[4]} evict={dv[5]} ext={dv[6]}")
    print("\nTop 15 tabelas por blocos lidos fora do shared_buffers (heap+idx+toast):")
    linhas = []
    for nome, v1 in t1["T"].items():
        v0 = t0["T"].get(nome, [0] * len(v1))
        dv = [x - y for x, y in zip(v1, v0)]
        dv[0] -= descontos.get(nome, 0)
        tot = dv[0] + dv[1] + dv[2]
        hits = dv[3] + dv[4]
        s1, s0 = t1["S"].get(nome), t0["S"].get(nome)
        seq = (s1[0] - s0[0]) if s1 and s0 else None
        linhas.append((tot, nome, dv, hits, seq))
    linhas.sort(reverse=True)
    total = sum(x[0] for x in linhas)
    print(f"  soma de todas as tabelas: {total} blocos = {mib(total):.0f} MiB")
    for tot, nome, dv, hits, seq in linhas[:15]:
        print(f"  {nome:<44} {mib(tot):8.1f} MiB (heap {dv[0]} idx {dv[1]} toast {dv[2]}) hits {hits} seq_scans {seq}")
    print("\nÍndices do Radar / titular_mei (idx_scan delta):")
    for nome, v1 in t1["IX"].items():
        v0 = t0["IX"].get(nome, [0, 0])
        print(f"  {nome:<44} scans +{v1[0]-v0[0]} (total {v1[0]}) tamanho {v1[1]/1048576:.0f} MiB")
    for nome in ("cron.job_run_details", "public.radar_empresas", "public.radar_contatos"):
        v1, v0, s1, s0 = t1["T"].get(nome), t0["T"].get(nome), t1["S"].get(nome), t0["S"].get(nome)
        if v1 and v0 and s1 and s0:
            print(f"\n{nome}: heap_read {v1[0]-v0[0]} idx_read {v1[1]-v0[1]} toast {v1[2]-v0[2]} hits {v1[3]-v0[3]+v1[4]-v0[4]} | seq_scan +{s1[0]-s0[0]} seq_tup_read +{s1[1]-s0[1]} idx_scan +{s1[2]-s0[2]} ins +{s1[3]-s0[3]} upd +{s1[4]-s0[4]} del +{s1[5]-s0[5]}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(__doc__)
    desc = {}
    if len(args) > 2:
        if args[2] != "--descontar":
            sys.exit(__doc__)
        for kv in args[3:]:
            nome, blocos = kv.split("=")
            desc[nome] = int(blocos)
    main(args[0], args[1], desc)
