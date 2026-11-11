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
};
