// sayersync — conector Go do SayerSystem (PostgreSQL local) para o app Colacor.
// Roda como serviço Windows (kardianos/service). Comportamento: delta por
// data_atualizacao com high-water mark da origem → POST lotes para tint-sync-agent.
//
// Subcomandos:
//
//	install    — configura (reaproveitando o config.json) e registra o serviço Windows SayerSync
//	uninstall  — remove o serviço Windows
//	run        — entry-point do serviço (chamado pelo SCM do Windows)
//	once       — executa 1 ciclo de sync no console (dev/debug)
//	discovery  — despeja schema do SayerSystem em sayersystem-schema.txt
//	version    — imprime a versão do binário
//
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §5
package main

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // driver database/sql via pgx
	"github.com/kardianos/service"
)

// Version é injetado via -ldflags no build de release.
// Ex: go build -ldflags "-X main.Version=1.0.0"
var Version = "dev"

// ──────────────────────────────────────────────
// Serviço Windows via kardianos/service
// ──────────────────────────────────────────────

// program implementa service.Interface.
type program struct {
	cfg    *Config
	cancel context.CancelFunc
	done   chan struct{}
}

func (p *program) Start(s service.Service) error {
	p.done = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	go p.run(ctx)
	return nil
}

func (p *program) Stop(_ service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	select {
	case <-p.done:
	case <-time.After(30 * time.Second):
	}
	return nil
}

func (p *program) run(ctx context.Context) {
	defer close(p.done)
	logger.Infof("sayersync %s iniciado (loop a cada %d min)", Version, p.cfg.IntervaloMin)
	// O ciclo de sync é implementado em sync.go (Task 9).
	// Aqui: ticker básico + placeholder para RunCycle.
	interval := time.Duration(p.cfg.IntervaloMin) * time.Minute
	for {
		select {
		case <-ctx.Done():
			logger.Info("sayersync encerrando")
			return
		default:
		}
		runOneCycle(ctx, p.cfg)
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

// ──────────────────────────────────────────────
// main
// ──────────────────────────────────────────────

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := strings.ToLower(os.Args[1])

	switch cmd {
	case "version":
		fmt.Printf("sayersync %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		return

	case "install":
		cmdInstall()

	case "uninstall":
		cmdUninstall()

	case "run":
		cmdRun()

	case "once":
		cmdOnce()

	case "discovery":
		cmdDiscovery()

	case "rollback":
		cmdRollback()

	default:
		fmt.Fprintf(os.Stderr, "Subcomando desconhecido: %q\n\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `sayersync %s — conector SayerSystem → Colacor app

Uso: sayersync <comando>

Comandos:
  install    Configurar e registrar o serviço Windows SayerSync (reaproveita o config.json;
             --manter-config = só registra serviço + recovery, sem perguntas)
  uninstall  Remover o serviço Windows SayerSync
  run        Entry-point do serviço (chamado pelo Windows SCM)
  once       Executar 1 ciclo de sync no console (teste/debug)
  discovery  Despejar o schema do SayerSystem em sayersystem-schema.txt
  rollback   Restaurar o binário anterior (uso interno: SCM run_command de recovery)
  version    Mostrar a versão do binário
`, Version)
}

// ──────────────────────────────────────────────
// install
// ──────────────────────────────────────────────

func cmdInstall() {
	if runtime.GOOS != "windows" {
		fmt.Fprintln(os.Stderr, "ERRO: o subcomando 'install' funciona somente no Windows.")
		fmt.Fprintln(os.Stderr, "       Em outras plataformas, use 'once' ou 'discovery' para desenvolvimento.")
		os.Exit(1)
	}

	// O config.json existente é a BASE (Enter mantém; campos não perguntados —
	// update_manifest_url, intervalo_min — são preservados). Malformado → aborta:
	// sobrescrever às cegas perderia o token e o auto-update. Ver install.go.
	atual, err := carregarConfigParaInstall(LoadConfig)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERRO: %v\n", err)
		fmt.Fprintf(os.Stderr, "       O install NÃO sobrescreve um config.json ilegível (perderia o token e o update_manifest_url).\n")
		fmt.Fprintf(os.Stderr, "       Corrija o arquivo %s ou renomeie-o para instalar do zero.\n", configPath())
		os.Exit(1)
	}

	var cfg *Config
	if temFlag(os.Args[2:], "--manter-config") {
		// Não interativo (suporte remoto / refazer recovery-copy): não toca no config.
		if err := validarConfigParaManter(atual); err != nil {
			fmt.Fprintf(os.Stderr, "ERRO: %v\n", err)
			os.Exit(1)
		}
		cfg = atual
		fmt.Println("--manter-config: config.json mantido como está; registrando o serviço.")
	} else {
		cfg = assistenteInstall(atual)
	}

	// Registra o serviço Windows.
	svcConfig := svcConfig(cfg)
	s, err := service.New(&program{cfg: cfg}, svcConfig)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERRO ao criar objeto de serviço: %v\n", err)
		os.Exit(1)
	}
	// Idempotente: remove registro anterior se existir (o INSTALACAO.md promete que
	// repetir o install é seguro; também conserta registro velho sem o argumento "run").
	_ = s.Stop()
	if err := s.Uninstall(); err == nil {
		// O SCM remove o serviço de forma assíncrona; dá tempo antes de recriar.
		time.Sleep(2 * time.Second)
	}
	var instErr error
	for i := 0; i < 3; i++ {
		if instErr = s.Install(); instErr == nil {
			break
		}
		time.Sleep(2 * time.Second)
	}
	if instErr != nil {
		fmt.Fprintf(os.Stderr, "ERRO ao instalar serviço: %v\n", instErr)
		os.Exit(1)
	}

	// Configura a rede de recuperação de crash-loop de BOOT: recovery-copy estável +
	// failure actions [restart, restart, run_command → rollback]. Sem isso o
	// auto-update não tem rollback automático. (Codex F2/F5)
	if exePath, exeErr := executablePath(); exeErr != nil {
		fmt.Fprintf(os.Stderr, "AVISO: não resolvi o caminho do exe para configurar recovery: %v\n", exeErr)
	} else {
		// install é deliberado: FORÇA o refresh do ator do rollback (mesmo se já
		// existe) para um balcão com recovery-copy velha/bugada poder atualizá-la
		// re-rodando install. O repair automático (start/pre-update) preserva. (Codex P1)
		if refErr := refreshRecoveryCopy(exePath); refErr != nil {
			fmt.Fprintf(os.Stderr, "AVISO: não atualizei a recovery-copy: %v\n", refErr)
		}
		if recErr := configureServiceRecovery(exePath); recErr != nil {
			fmt.Fprintf(os.Stderr, "AVISO: não configurei as ações de recovery do serviço: %v\n", recErr)
			fmt.Fprintln(os.Stderr, "       O auto-update fica SEM rollback automático até isso ser corrigido (re-rodar install).")
		}
	}

	if err := s.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "AVISO: serviço instalado mas não iniciou: %v\n", err)
		fmt.Fprintln(os.Stderr, "       Rode 'sayersync.exe once' para ver o erro no console.")
	} else {
		fmt.Println("Serviço SayerSync instalado e iniciado com sucesso.")
	}
	fmt.Println()
	fmt.Println("Próximo passo: verifique o heartbeat em /tintometrico/integracao → Integrações.")
}

// assistenteInstall pergunta os campos (defaults = config atual, se houver), mescla
// e grava o config.json. Sai do processo em erro — nada é gravado nesse caso.
func assistenteInstall(atual *Config) *Config {
	reader := bufio.NewReader(os.Stdin)
	base := baseDoInstall(atual)

	fmt.Println("=== sayersync — configuração do serviço ===")
	if atual != nil {
		fmt.Println("config.json existente encontrado: Enter mantém cada valor atual.")
	}
	fmt.Println()

	var r respostasInstall
	r.AppURL = promptCru(reader, "URL do app", base.AppURL)
	r.StoreCode = promptCru(reader, "store_code (ex: colacor-divinopolis)", base.StoreCode)
	if temTokenSalvo(atual) {
		r.Token = promptCru(reader, "Token de sync (Enter mantém o token atual; cole um novo para trocar)", "")
	} else {
		r.Token = promptCru(reader, "Token de sync (copiado de /tintometrico/integracao)", "")
	}
	r.PGConn = promptCru(reader, "String de conexão PostgreSQL", mascararSenhaPG(base.PGConn))

	// Protege o token NOVO com DPAPI (escopo de máquina — LocalService descriptografa).
	tokenEnc := ""
	if strings.TrimSpace(r.Token) != "" {
		enc, err := encryptToken(strings.TrimSpace(r.Token))
		if err != nil {
			fmt.Fprintf(os.Stderr, "ERRO ao proteger o token com DPAPI: %v\n", err)
			os.Exit(1)
		}
		tokenEnc = enc
	}

	cfg, err := mesclarConfigInstall(atual, r, tokenEnc, Version)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERRO: %v. Nada foi gravado.\n", err)
		os.Exit(1)
	}
	if err := SaveConfig(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "ERRO ao salvar config.json: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("config.json salvo.")
	return cfg
}

// ──────────────────────────────────────────────
// uninstall
// ──────────────────────────────────────────────

func cmdUninstall() {
	if runtime.GOOS != "windows" {
		fmt.Fprintln(os.Stderr, "ERRO: o subcomando 'uninstall' funciona somente no Windows.")
		os.Exit(1)
	}

	cfg, err := LoadConfig()
	if err != nil {
		// Config pode não existir; ainda tenta remover com valores mínimos.
		cfg = &Config{}
	}

	svcCfg := svcConfig(cfg)
	s, err := service.New(&program{cfg: cfg}, svcCfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERRO: %v\n", err)
		os.Exit(1)
	}
	_ = s.Stop()
	if err := s.Uninstall(); err != nil {
		fmt.Fprintf(os.Stderr, "ERRO ao remover serviço: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Serviço SayerSync removido.")
}

// ──────────────────────────────────────────────
// run (entry-point do Windows SCM)
// ──────────────────────────────────────────────

func cmdRun() {
	cfg, err := LoadConfig()
	if err != nil {
		logger.Errorf("Falha ao carregar config.json: %v", err)
		os.Exit(1)
	}

	svcCfg := svcConfig(cfg)
	prg := &program{cfg: cfg}
	s, err := service.New(prg, svcCfg)
	if err != nil {
		logger.Errorf("Falha ao criar serviço: %v", err)
		os.Exit(1)
	}

	// Self-heal (Codex F5): instalações antigas ou edições manuais podem não ter as
	// ações de recovery OU a recovery-copy. ensureRecoveryConfigured checa AMBOS
	// (actions + ator do rollback) e repara; loga sem bloquear o start.
	if err := ensureRecoveryConfigured(); err != nil {
		logger.Warnf("recovery: rede de recuperação incompleta no start: %v", err)
	}

	if err := s.Run(); err != nil {
		logger.Errorf("Serviço encerrou com erro: %v", err)
		os.Exit(1)
	}
}

// ──────────────────────────────────────────────
// once (1 ciclo, console)
// ──────────────────────────────────────────────

func cmdOnce() {
	// `once` é debug/manual: NÃO deve auto-atualizar (trocaria o binário de produção
	// e os.Exit(90) fora do recovery do SCM; evita corrida com o serviço). (Codex F6/F7)
	autoUpdateEnabled = false

	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Falha ao carregar config.json: %v\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	fmt.Printf("sayersync %s — ciclo único\n", Version)
	ok := runOneCycle(ctx, cfg)
	if !ok {
		// F7: ciclo com qualquer falha → exit != 0 (CI/scripts/debug detectam).
		fmt.Fprintln(os.Stderr, "Ciclo concluído COM FALHAS (ver logs acima).")
		os.Exit(1)
	}
	fmt.Println("Ciclo concluído com sucesso.")
}

// ──────────────────────────────────────────────
// discovery
// ──────────────────────────────────────────────

func cmdDiscovery() {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Falha ao carregar config.json: %v\nUse 'install' primeiro ou certifique-se de que config.json existe ao lado do exe.\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	db, err := Connect(ctx, cfg.PGConn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Falha ao conectar ao PostgreSQL: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	outPath := filepath.Join(exeDir(), "sayersystem-schema.txt")
	fp, err := RunDiscovery(ctx, db, outPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Falha no discovery: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Schema salvo em: %s\nFingerprint: %s\n", outPath, fp)
}

// ──────────────────────────────────────────────
// rollback (ATOR EXTERNO de recovery — via SCM run_command)
// ──────────────────────────────────────────────

// cmdRollback é o ator externo do recovery de crash-loop de BOOT: o SCM o dispara
// (SC_ACTION_RUN_COMMAND) a partir da recovery-copy estável quando o binário novo
// crash-loopa no boot. Restaura o .prev, quarentena a versão ruim e reinicia o
// serviço. Recebe o exe-alvo via --target — a recovery-copy roda de OUTRO caminho,
// então NÃO pode derivar o alvo de os.Executable. (Codex F2)
func cmdRollback() {
	target := parseTargetFlag(os.Args)
	if target == "" {
		fmt.Fprintln(os.Stderr, "ERRO: rollback requer --target <caminho absoluto do sayersync.exe>")
		os.Exit(1)
	}
	if err := doRollback(target); err != nil {
		logger.Errorf("rollback falhou: %v", err)
		os.Exit(1)
	}
	fmt.Println("Rollback concluído.")
}

// ──────────────────────────────────────────────
// svcConfig — configuração do serviço Windows
// ──────────────────────────────────────────────

func svcConfig(_ *Config) *service.Config {
	return &service.Config{
		Name:        serviceName, // = "SayerSync"; casa com as syscalls de recovery
		DisplayName: "SayerSync — Colacor Tintométrico",
		Description: "Sincroniza formulas e precos do SayerSystem com o app Colacor.",
		// O SCM do Windows executa o binário com ESTES argumentos. Sem o "run",
		// o main() imprime a ajuda e sai(1) → o SCM dá timeout 1053
		// ("não respondeu a requisição de início em tempo hábil"). Bug real em campo (12/06).
		Arguments: []string{"run"},
		// Roda como LocalService (least privilege; precisa só de localhost + HTTPS de saída).
		// No Windows, 'UserName: "NT AUTHORITY\\LocalService"' seria a config ideal;
		// por simplicidade v1 usamos o usuário do sistema (LocalSystem via kardianos default).
		// DPAPI machine-scope permite que qualquer conta do sistema descriptografe o token.
		Option: service.KeyValue{
			// Reinicia automaticamente em caso de falha (OnFailure = SERVICE_RECOVERY).
			"OnFailure": "restart",
		},
	}
}

// ──────────────────────────────────────────────
// runOneCycle — delega ao RunCycle de sync.go.
// Retorna true se o ciclo foi totalmente bem-sucedido (F7).
// ──────────────────────────────────────────────

func runOneCycle(ctx context.Context, cfg *Config) bool {
	return RunCycle(ctx, cfg)
}

// ──────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────

// promptCru mostra o default (que pode estar mascarado) e devolve a resposta CRUA:
// "" = Enter. Quem aplica o default é mesclarConfigInstall.
func promptCru(r *bufio.Reader, question, shownDefault string) string {
	if shownDefault != "" {
		fmt.Printf("%s [%s]: ", question, shownDefault)
	} else {
		fmt.Printf("%s: ", question)
	}
	line, _ := r.ReadString('\n')
	return strings.TrimSpace(line)
}

// exeDir retorna o diretório do executável atual (para gravar config/state/schema).
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// logger é o logger global (inicializado abaixo para evitar init circular).
var logger svcLogger

// svcLogger é um logger simples que vai para stdout (adequado para console/service).
type svcLogger struct{}

func (svcLogger) Infof(format string, args ...any) {
	fmt.Printf("[INFO]  "+format+"\n", args...)
}
func (svcLogger) Warnf(format string, args ...any) {
	fmt.Printf("[WARN]  "+format+"\n", args...)
}
func (svcLogger) Errorf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[ERROR] "+format+"\n", args...)
}
func (svcLogger) Info(msg string)  { logger.Infof("%s", msg) }
func (svcLogger) Warn(msg string)  { logger.Warnf("%s", msg) }
func (svcLogger) Error(msg string) { logger.Errorf("%s", msg) }

// Importações usadas nos comandos mas declaradas em outros arquivos — evita erros de compile.
var _ = (*sql.DB)(nil)
