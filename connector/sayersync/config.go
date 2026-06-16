// config.go — carrega e salva a configuração do conector em config.json,
// ao lado do executável. O token de sync é protegido com DPAPI (Windows, escopo
// de máquina) para que a conta LocalService consiga descriptografar o token
// que o admin gravou durante o 'install'.
//
// Em plataformas não-Windows (dev), o token é armazenado em plaintext no campo
// TokenPlainDev com um aviso explícito — NÃO usar em produção.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config persiste em config.json ao lado do executável.
type Config struct {
	AppURL    string `json:"app_url"`
	StoreCode string `json:"store_code"`

	// TokenEnc armazena o token cifrado com DPAPI (base64), escopo de máquina.
	// Somente preenchido no Windows.
	TokenEnc string `json:"token_dpapi,omitempty"`

	// TokenPlainDev armazena o token em plaintext APENAS para desenvolvimento
	// em plataformas não-Windows. NUNCA usar em produção.
	// ⚠️ AVISO: este campo expõe o token sem proteção. Usar somente em máquinas de dev.
	TokenPlainDev string `json:"token_plain_dev,omitempty"`

	// PGConn é a string de conexão para o PostgreSQL local do SayerSystem.
	// Valor padrão: postgres://integra:integra@localhost:5986/client_industrial_sayerlack
	PGConn string `json:"pg_conn"`

	// IntervaloMin é o intervalo entre ciclos de sync, em minutos. Padrão: 10.
	IntervaloMin int `json:"intervalo_min"`

	// BuiltVersion registra a versão do binário que escreveu esta config.
	BuiltVersion string `json:"built_version,omitempty"`

	// UpdateManifestURL é a URL pública do manifesto de atualização automática.
	// Exemplo: https://<project>.supabase.co/storage/v1/object/public/releases/sayersync/manifest.json
	// Vazio = auto-update desativado.
	UpdateManifestURL string `json:"update_manifest_url,omitempty"`
}

// configDefaults retorna uma Config com os valores padrão.
func configDefaults() *Config {
	return &Config{
		AppURL:       "https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/tint-sync-agent",
		PGConn:       "postgres://integra:integra@localhost:5986/client_industrial_sayerlack",
		IntervaloMin: 10,
	}
}

// configPath retorna o caminho do config.json ao lado do executável.
func configPath() string {
	return filepath.Join(exeDir(), "config.json")
}

// LoadConfig carrega o config.json. Retorna erro se o arquivo não existir ou
// estiver malformado.
func LoadConfig() (*Config, error) {
	path := configPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config.json não encontrado em %s: %w", path, err)
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("config.json malformado: %w", err)
	}
	if cfg.IntervaloMin <= 0 {
		cfg.IntervaloMin = 10
	}
	return &cfg, nil
}

// SaveConfig serializa a Config para config.json, com escrita atômica
// (tmp → rename) para evitar config corrompida caso o processo seja encerrado
// no meio da gravação.
func SaveConfig(cfg *Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("erro ao serializar config: %w", err)
	}

	path := configPath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return fmt.Errorf("erro ao escrever config tmp: %w", err)
	}
	return os.Rename(tmp, path)
}

// Token retorna o token de sync em plaintext.
// No Windows: descriptografa o TokenEnc via DPAPI.
// Em outras plataformas: retorna TokenPlainDev com aviso no log.
func (c *Config) Token() (string, error) {
	return decryptToken(c)
}
