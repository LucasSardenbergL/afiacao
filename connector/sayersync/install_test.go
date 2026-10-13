package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const manifestURLLoja = "https://fzvklzpomgnyikkfkzai.supabase.co/storage/v1/object/public/releases/sayersync/manifest.json"

// configDaLoja reproduz o config.json da M01 em 2026-10-13 (auto-update ATIVO).
func configDaLoja() *Config {
	return &Config{
		AppURL:            "https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/tint-sync-agent",
		StoreCode:         "M01",
		TokenEnc:          "dpapi-base64-atual",
		PGConn:            "postgres://integra:segredo@localhost:5986/client_industrial_sayerlack",
		IntervaloMin:      7,
		BuiltVersion:      "0.2.2",
		UpdateManifestURL: manifestURLLoja,
	}
}

// Regressão do bug de campo (M01, 2026-10-13): reinstalar apertando só Enter
// apagava update_manifest_url (auto-update desligado em silêncio) e resetava o
// intervalo. Agora Enter mantém tudo.
func TestMesclarInstall_EnterEmTudoPreservaConfigInteiro(t *testing.T) {
	atual := configDaLoja()
	novo, err := mesclarConfigInstall(atual, respostasInstall{}, "", "0.2.3")
	if err != nil {
		t.Fatalf("Enter em tudo com config válido não pode falhar: %v", err)
	}
	if novo.UpdateManifestURL != manifestURLLoja {
		t.Fatalf("update_manifest_url = %q; esperado preservado (senão o auto-update desliga)", novo.UpdateManifestURL)
	}
	if novo.IntervaloMin != 7 {
		t.Fatalf("intervalo_min = %d; esperado 7 preservado", novo.IntervaloMin)
	}
	if novo.TokenEnc != "dpapi-base64-atual" {
		t.Fatalf("token_dpapi trocado sem o operador colar token novo")
	}
	if novo.StoreCode != "M01" || novo.PGConn != atual.PGConn || novo.AppURL != atual.AppURL {
		t.Fatalf("campos perguntados não mantidos no Enter: %+v", novo)
	}
	if novo.BuiltVersion != "0.2.3" {
		t.Fatalf("built_version = %q; esperado a versão que gravou (0.2.3)", novo.BuiltVersion)
	}
	if atual.BuiltVersion != "0.2.2" {
		t.Fatalf("mesclar MUTOU a base (built_version=%q) — deve trabalhar numa cópia", atual.BuiltVersion)
	}
}

func TestMesclarInstall_RespostaSubstituiSoOCampoRespondido(t *testing.T) {
	novo, err := mesclarConfigInstall(configDaLoja(),
		respostasInstall{StoreCode: "  M02  ", PGConn: "postgres://x:y@h:1/db"}, "dpapi-novo", "0.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if novo.StoreCode != "M02" || novo.PGConn != "postgres://x:y@h:1/db" || novo.TokenEnc != "dpapi-novo" {
		t.Fatalf("respostas não aplicadas: %+v", novo)
	}
	if novo.UpdateManifestURL != manifestURLLoja || novo.IntervaloMin != 7 {
		t.Fatalf("campo não perguntado perdido: %+v", novo)
	}
}

func TestMesclarInstall_PreservaTokenPlainDev(t *testing.T) {
	atual := configDaLoja()
	atual.TokenPlainDev = "dev-only"
	novo, err := mesclarConfigInstall(atual, respostasInstall{}, "", "0.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if novo.TokenPlainDev != "dev-only" {
		t.Fatalf("campo não perguntado token_plain_dev perdido")
	}
}

func TestMesclarInstall_SemConfig_FluxoLimpo(t *testing.T) {
	novo, err := mesclarConfigInstall(nil, respostasInstall{StoreCode: "M09"}, "dpapi-x", "0.2.3")
	if err != nil {
		t.Fatal(err)
	}
	def := configDefaults()
	if novo.AppURL != def.AppURL || novo.PGConn != def.PGConn || novo.IntervaloMin != 10 {
		t.Fatalf("instalação limpa deveria usar os defaults: %+v", novo)
	}
	if novo.UpdateManifestURL != "" {
		t.Fatalf("instalação limpa não inventa update_manifest_url")
	}
}

func TestMesclarInstall_ObrigatoriosAusentesAbortam(t *testing.T) {
	if _, err := mesclarConfigInstall(nil, respostasInstall{}, "dpapi-x", "v"); err == nil || !strings.Contains(err.Error(), "store_code") {
		t.Fatalf("sem config e sem store_code → erro de store_code; veio %v", err)
	}
	if _, err := mesclarConfigInstall(nil, respostasInstall{StoreCode: "M01"}, "", "v"); err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("sem config e sem token → erro de token; veio %v", err)
	}
	semToken := configDaLoja()
	semToken.TokenEnc = ""
	if _, err := mesclarConfigInstall(semToken, respostasInstall{}, "", "v"); err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("config sem token_dpapi + Enter → erro de token; veio %v", err)
	}
}

func TestMesclarInstall_IntervaloInvalidoViraDez(t *testing.T) {
	atual := configDaLoja()
	atual.IntervaloMin = 0
	novo, err := mesclarConfigInstall(atual, respostasInstall{}, "", "v")
	if err != nil {
		t.Fatal(err)
	}
	if novo.IntervaloMin != 10 {
		t.Fatalf("intervalo_min=%d; esperado 10", novo.IntervaloMin)
	}
}

func TestTemTokenSalvo_DecidePedirToken(t *testing.T) {
	if temTokenSalvo(nil) {
		t.Fatal("sem config → precisa pedir token")
	}
	if !temTokenSalvo(configDaLoja()) {
		t.Fatal("com token_dpapi → Enter mantém, não exige texto")
	}
	vazio := configDaLoja()
	vazio.TokenEnc = ""
	if temTokenSalvo(vazio) {
		t.Fatal("config sem token_dpapi → precisa pedir token")
	}
}

// Contra o LoadConfig REAL (arquivo em disco): ausente = limpo; malformado = aborta.
func TestCarregarConfigParaInstall_ArquivoReal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	load := func() (*Config, error) { return loadConfigDe(path) }

	cfg, err := carregarConfigParaInstall(load)
	if err != nil || cfg != nil {
		t.Fatalf("ausente → (nil,nil); veio (%v,%v)", cfg, err)
	}

	if err := os.WriteFile(path, []byte(`{"store_code": "M01", "token_dpapi": `), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err = carregarConfigParaInstall(load)
	if err == nil || cfg != nil || !strings.Contains(err.Error(), "malformado") {
		t.Fatalf("malformado → abortar com erro 'malformado'; veio (%v,%v)", cfg, err)
	}

	data, _ := json.Marshal(configDaLoja())
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err = carregarConfigParaInstall(load)
	if err != nil || cfg == nil || cfg.UpdateManifestURL != manifestURLLoja {
		t.Fatalf("válido → base carregada; veio (%v,%v)", cfg, err)
	}
}

func TestCarregarConfigParaInstall_ErroDeLeituraNaoEhAusente(t *testing.T) {
	_, err := carregarConfigParaInstall(func() (*Config, error) {
		return nil, fmt.Errorf("ler: %w", os.ErrPermission)
	})
	if err == nil {
		t.Fatal("erro que não é 'não existe' (ex.: permissão) deve abortar, não virar instalação limpa")
	}
	_, err = carregarConfigParaInstall(func() (*Config, error) {
		return nil, fmt.Errorf("config.json não encontrado: %w", os.ErrNotExist)
	})
	if err != nil {
		t.Fatalf("não existe embrulhado com %%w → instalação limpa; veio %v", err)
	}
	if !errors.Is(fmt.Errorf("x: %w", os.ErrNotExist), os.ErrNotExist) {
		t.Fatal("sanidade")
	}
}

func TestValidarConfigParaManter(t *testing.T) {
	if err := validarConfigParaManter(configDaLoja()); err != nil {
		t.Fatalf("config válido → ok; veio %v", err)
	}
	if validarConfigParaManter(nil) == nil {
		t.Fatal("--manter-config sem config → erro")
	}
	semStore := configDaLoja()
	semStore.StoreCode = ""
	if validarConfigParaManter(semStore) == nil {
		t.Fatal("--manter-config sem store_code → erro")
	}
	semToken := configDaLoja()
	semToken.TokenEnc = ""
	if validarConfigParaManter(semToken) == nil {
		t.Fatal("--manter-config sem token → erro")
	}
}

func TestTemFlag(t *testing.T) {
	if !temFlag([]string{"--manter-config"}, "--manter-config") || temFlag([]string{"--manter"}, "--manter-config") || temFlag(nil, "--manter-config") {
		t.Fatal("temFlag deve casar só a flag exata")
	}
}

func TestMascararSenhaPG(t *testing.T) {
	got := mascararSenhaPG("postgres://integra:segredo@localhost:5986/client_industrial_sayerlack")
	if strings.Contains(got, "segredo") || !strings.Contains(got, "integra:***@localhost:5986") {
		t.Fatalf("senha não mascarada: %q", got)
	}
	if got := mascararSenhaPG("postgres://integra@localhost/db"); got != "postgres://integra@localhost/db" {
		t.Fatalf("sem senha → inalterado; veio %q", got)
	}
	if got := mascararSenhaPG("host=localhost password=segredo"); strings.Contains(got, "segredo") {
		t.Fatalf("formato keyword vazou senha: %q", got)
	}
}
