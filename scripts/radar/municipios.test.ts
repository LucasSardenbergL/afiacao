import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coordenadaDoMunicipio, indexarCoordenadasIbge } from "./municipios";

const linhasCsv = readFileSync("scripts/radar/municipios-ibge.csv", "utf-8").split("\n").slice(1).filter(Boolean);
const idx = indexarCoordenadasIbge(linhasCsv);

describe("coordenadaDoMunicipio — código RFB = siafi_id do IBGE", () => {
  it("[M1] grafia da RFB que diverge do IBGE casa pelo código (estes ficavam sem coordenada em prod)", () => {
    // Nomes exatamente como vêm em radar_municipios (prod 2026-11-02).
    expect(coordenadaDoMunicipio(idx, "8251", "BALNEARIO DE PICARRAS", "SC")).toEqual({ lat: -26.7639, lng: -48.6717 });
    expect(coordenadaDoMunicipio(idx, "5875", "PARATI", "RJ")).toEqual({ lat: -23.2221, lng: -44.7175 });
    expect(coordenadaDoMunicipio(idx, "1603", "ASSU", "RN")).toEqual({ lat: -5.58362, lng: -36.914 });
    expect(coordenadaDoMunicipio(idx, "0529", "SANTA ISABEL DO PARA", "PA")).toEqual({ lat: -1.29686, lng: -48.1606 });
    expect(coordenadaDoMunicipio(idx, "4177", "BRASOPOLIS", "MG")).toEqual({ lat: -22.4743, lng: -45.6166 });
  });

  it("[M2] o código vence o nome: um nome de OUTRO município não desvia a coordenada", () => {
    // 4445 = siafi de Divinópolis (MG). Nome e UF de Joinville não podem ganhar do código.
    const porCodigo = coordenadaDoMunicipio(idx, "4445", "JOINVILLE", "SC");
    const divinopolis = coordenadaDoMunicipio(idx, "", "DIVINOPOLIS", "MG");
    expect(divinopolis).toBeDefined();
    expect(porCodigo).toEqual(divinopolis);
  });

  it("[M3] sem código conhecido, cai no nome normalizado da UF; sem nenhum dos dois, undefined (nunca 0,0)", () => {
    expect(coordenadaDoMunicipio(idx, "XXXX", "DIVINOPOLIS", "MG")).toEqual(coordenadaDoMunicipio(idx, "4445", "", "MG"));
    expect(coordenadaDoMunicipio(idx, "9707", "EXTERIOR", "EX")).toBeUndefined();
  });

  it("[M4] o índice por código cobre todas as linhas do CSV (siafi_id sem duplicata)", () => {
    expect(idx.porSiafi.size).toBe(linhasCsv.length);
  });
});
