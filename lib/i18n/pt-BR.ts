/**
 * Catálogo pt-BR. Tipado contra o catálogo en: chave faltando é erro de tsc.
 */
import type { en } from "./en.ts";

export const ptBR: Record<keyof typeof en, string> = {
	"mode.on": "ativado",
	"mode.off": "desativado",
	"workers.running": "em execução",
	"workers.queued": "na fila",
	"workers.finished": "concluídos",
	"workers.count": "{count} workers",
	"status.label": "Situação",
	"confirm.yes": "Sim",
	"confirm.no": "Não",
	"confirm.abortWorkers": "Abortar {count} workers em execução?",
	"confirm.cancelled": "Cancelado.",

	"cmd.foreman.desc": "Entrar no modo orquestrador e iniciar o fluxo do foreman (/foreman off para sair)",
	"cmd.audit.desc": "Entrar no modo orquestrador e executar uma auditoria somente leitura do código",
	"cmd.diagnose.desc": "Diagnosticar por que uma execução do foreman ou do plan-runner deu errado (não altera o modo)",
	"cmd.planRunner.desc": "Entrar no modo orquestrador e executar um plano aprovado em docs/plans/",
	"cmd.status.desc": "Mostrar o modo orquestrador e a situação dos workers (sem chamar o modelo)",

	"cmd.entered": "Modo orquestrador ativado. Use /foreman off para sair.",
	"cmd.envForcedOff": "FOREMAN_PI_MODE=off impede o modo orquestrador. Remova a variável para usar este comando.",
	"cmd.off.done": "Modo orquestrador desativado. Ferramentas restauradas.",
	"cmd.off.already": "O modo orquestrador já está desativado.",
	"cmd.off.envForced": "O modo orquestrador está forçado por FOREMAN_PI_MODE=orchestrator. Remova a variável para sair.",
	"cmd.off.confirmTitle": "Sair do modo orquestrador?",
	"cmd.off.confirm": "{count} workers ainda estão em execução. Abortá-los e sair do modo orquestrador?",
	"cmd.off.refuseNoUi": "{count} workers estão em execução. Execute /foreman off de forma interativa ou espere que terminem. Permanecendo no modo orquestrador.",
	"cmd.off.staying": "Permanecendo no modo orquestrador.",
	"cmd.off.aborted": "{count} workers abortados.",
	"cmd.plan.usage": "Uso: /plan-runner <arquivo do plano ou slug>",
	"cmd.plan.missing": "Arquivo do plano não encontrado: {path}. Enviando o caminho mesmo assim.",

	"confirm.keepMode.title": "Manter o modo orquestrador?",
	"confirm.keepMode": "Esta sessão estava no modo orquestrador. Manter ativado?",

	"status.modeOn": "foreman: modo orquestrador",
	"status.workers": "workers: {running} em execução, {queued} na fila",
	"widget.step": "etapa {step}",
	"widget.queued": "{count} na fila",
	"widget.state.completed": "concluído",
	"widget.state.failed": "falhou",
	"widget.state.blocked": "bloqueado",
	"widget.state.aborted": "abortado",

	"report.title": "Situação do foreman",
	"report.mode": "Modo orquestrador: {state} ({source})",
	"report.workers": "Workers: {running} em execução, {queued} na fila",
	"report.none": "Nenhum worker foi executado nesta sessão.",
	"report.running": "Em execução:",
	"report.recent": "Recentes:",
	"report.source.subagent": "processo worker",
	"report.source.env": "ambiente",
	"report.source.entry": "entrada da sessão",
	"report.source.event": "esta sessão",
	"report.source.default": "padrão",
};
