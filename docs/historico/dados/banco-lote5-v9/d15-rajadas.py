#!/usr/bin/env python3
"""D15: agrupa a série de d15-amostra.out em rajadas (amostras consecutivas em que o contador de
temp relation muda) e imprime o delta de cada rajada e do controle (fora de rajada).
Uso: python3 -I d15-rajadas.py d15-amostra.out
Só lê arquivo local."""
import sys

BLOCO = 8192


def pa(linha):
    c = [x.strip() for x in linha.split(" | ")]
    if len(c) < 6:
        return None
    t = c[0]
    tmp = c[1].split(":", 1)[1].split("/") if ":" in c[1] else ["0"] * 5
    wal = c[2].split("/")
    cat = {}
    for item in c[3].split(","):
        n, v = item.split(":")
        cat[n] = [int(x) for x in v.split("/")]
    xact, tb = c[4].split("/")
    rr, rh = c[5].split("/")
    return {
        "t": t,
        "tmp": [int(x) for x in tmp],
        "wal": [int(x) for x in wal],
        "cat": cat,
        "xact": int(xact),
        "tb": int(tb),
        "rd": int(rr),
        "rh": int(rh),
    }


def seg(s):
    h, m, x = (int(v) for v in s.split(":"))
    return h * 3600 + m * 60 + x


def dif(a, b):
    return {
        "dur": seg(b["t"]) - seg(a["t"]),
        "tmp": [y - x for x, y in zip(a["tmp"], b["tmp"])],
        "wal_rec": b["wal"][0] - a["wal"][0],
        "wal_fpi": b["wal"][1] - a["wal"][1],
        "wal_mib": (b["wal"][2] - a["wal"][2]) / 1048576,
        "cat": {n: [y - x for x, y in zip(a["cat"][n], b["cat"][n])] for n in a["cat"]},
        "xact": b["xact"] - a["xact"],
        "tb": b["tb"] - a["tb"],
        "rd": b["rd"] - a["rd"],
    }


def fmt(nome, d):
    r, w, h, ev, ex = d["tmp"]
    cat = " ".join(f"{n.replace('pg_', '')}+{v[0]}/-{v[1]}" for n, v in sorted(d["cat"].items()))
    return (
        f"{nome}: {d['dur']} s | temp relation: reads {r} ({r*BLOCO/1048576:.1f} MiB) writes {w} ({w*BLOCO/1048576:.1f} MiB) "
        f"hits {h} evict {ev} extends {ex} | WAL {d['wal_mib']:.2f} MiB ({d['wal_rec']} rec, {d['wal_fpi']} fpi) | "
        f"catálogo ins/del {cat} | xact {d['xact']} | temp_bytes {d['tb']} | relation reads {d['rd']}"
    )


def main(path):
    amostras = [x for x in (pa(l) for l in open(path, encoding="utf-8") if l.strip() and not l.startswith("#")) if x]
    if len(amostras) < 3:
        sys.exit("poucas amostras")
    mudou = [i for i in range(1, len(amostras)) if amostras[i]["tmp"] != amostras[i - 1]["tmp"]]
    rajadas, atual = [], []
    for i in mudou:
        if atual and seg(amostras[i]["t"]) - seg(amostras[atual[-1]]["t"]) > 30:
            rajadas.append(atual)
            atual = []
        atual.append(i)
    if atual:
        rajadas.append(atual)
    print(f"{len(amostras)} amostras de {amostras[0]['t']} a {amostras[-1]['t']} UTC; {len(rajadas)} rajada(s) de temp relation (lacuna > 30 s separa)")
    for r in rajadas:
        a, b = amostras[r[0] - 1], amostras[r[-1]]
        print(fmt(f"rajada {amostras[r[0]]['t']}-{b['t']}", dif(a, b)))
    # controle: maior trecho sem mudança de temp relation
    ini, melhor = 0, (0, 0, 0)
    for i in mudou + [len(amostras) - 1]:
        if i - ini > melhor[0]:
            melhor = (i - ini, ini, i)
        ini = i
    _, a, b = melhor
    print(fmt(f"controle {amostras[a]['t']}-{amostras[b]['t']} (sem temp relation)", dif(amostras[a], amostras[b])))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
