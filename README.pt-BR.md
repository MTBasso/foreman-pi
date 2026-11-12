# foreman-pi

🇬🇧 English: [README.md](README.md)

Um pacote do [Pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`) que porta o
[`foreman`](https://github.com/MTBasso/foreman), um plugin do Claude Code: uma
sessão orquestradora que faz perguntas, planeja, constrói, testa e entrega,
sempre delegando para agentes de trabalho dedicados e nunca editando código por
conta própria.

Versão 0.3.0. Veja o [CHANGELOG.md](CHANGELOG.md) (em inglês) para o que mudou.
O contexto de design e a pesquisa de viabilidade original estão em
[PLAN.md](https://github.com/MTBasso/foreman-pi/blob/main/PLAN.md); o plano de implementação da 0.2.0 é
[docs/plans/foreman-pi-pi-native-improvements.md](https://github.com/MTBasso/foreman-pi/blob/main/docs/plans/foreman-pi-pi-native-improvements.md).
(Esses dois arquivos ficam no repositório e não fazem parte do pacote publicado.)

## Instalação

```bash
pi install git:github.com/MTBasso/foreman-pi   # a partir do git
pi install ./foreman-pi                         # ou de um checkout local
```

O manifesto `pi` em `package.json` registra as extensões de
`extensions/*/index.ts` e as skills de `skills/`. Os agentes (`agents/*.md`),
as referências e os templates são encontrados relativamente ao pacote
instalado. `npm run test:package` empacota o tarball e o instala em um sandbox
descartável (nunca no seu `~/.pi` real) para provar que o layout publicado
carrega.

## Início rápido

1. Abra o `pi` no seu projeto e rode `/foreman`. Isso liga o modo orquestrador
   e inicia o fluxo do foreman: ele te faz perguntas sobre a tarefa, planeja e
   delega o trabalho.
2. No modo orquestrador, a própria sessão não consegue editar: `write`, `edit`
   e `bash` são removidos e negados. A única ferramenta de ação é
   `foreman_delegate`.
3. Os workers rodam como processos `pi` separados, em segundo plano. Quando
   terminam, você é acordado com uma mensagem `foreman-task-notification`.
4. `/foreman-status` mostra o modo e os workers; `/foreman off` sai do modo.

Para um plano já aprovado em `docs/plans/`, use `/plan-runner <plano>`.

| Comando | O que faz |
|---|---|
| `/foreman [tarefa]` | Entra no modo orquestrador e inicia o fluxo do foreman. |
| `/foreman off` | Sai do modo e restaura as ferramentas. Se houver workers rodando, pede confirmação antes de abortá-los; sem UI, recusa. |
| `/foreman-status` | Mostra o modo e o estado dos workers (sem chamada ao modelo). |
| `/foreman-audit` | Entra no modo orquestrador e executa uma auditoria somente leitura da base de código. |
| `/foreman-diagnose` | Diagnostica por que uma execução do foreman ou do plan-runner deu errado. Não altera o modo. |
| `/plan-runner <plano>` | Entra no modo orquestrador e executa um plano aprovado de `docs/plans/`. |

## Arquitetura

| Peça | Papel |
|---|---|
| `extensions/foreman-mode/` | Os comandos de barra, a entrada na barra de status e o widget de workers. Dono da entrada de modo persistida. |
| `extensions/orchestrator-guardrail/` | Com o modo ligado: remove `bash`/`write`/`edit` das ferramentas ativas e os nega em `tool_call`. Escritas no `FOREMAN_MEMORY.md` da raiz do projeto passam. |
| `extensions/coordination/` | A ferramenta `foreman_delegate` e o coordenador orientado a eventos: cria workers, enfileira, agrupa conclusões, escreve o ledger e interpreta o contrato de relatório. O `/foreman-status` fica aqui. |
| `extensions/context-filter/` | Poda mensagens `foreman-task-notification` antigas antes de cada chamada ao LLM. |
| `extensions/session-reminder/` | Lembrete único de sessão (estado do modo, disponibilidade do `foreman_delegate`, memória do projeto) e o aviso de retomada/fork "manter o modo orquestrador?". |
| `extensions/worker-guard/` | Política de escrita/bash por papel dentro dos processos de worker. |
| `extensions/model-fallback/` | O modelo virtual `foreman/hybrid`. Veja "Fallback de modelo" abaixo. |
| `lib/` | Módulos compartilhados: `roles.ts`, `agents.ts` (descoberta), `spawn.ts` (`pi` filho), `model-policy.ts`, `mode.ts`, `i18n.ts`, `workers.ts`, `ui.ts`. |
| `agents/`, `skills/`, `references/`, `templates/` | Definições dos workers, as skills do orquestrador, documentos de apoio e o template de handoff. |

A delegação não bloqueia. `foreman_delegate` retorna imediatamente com
`{task_id, run_id, state: running|queued, ack}`, o orquestrador encerra o turno
e o coordenador o acorda quando os workers terminam. As conclusões são agrupadas
(debounce) em uma única mensagem com N blocos:

```
<task-notification>
task-id: t1-planner
role: planner
status: completed        # completed | failed | blocked
plan-step: 2             # ou -
summary: <primeiros ~400 caracteres do relatório do worker>
output: .foreman/runs/<run-id>/t1-planner.md
</task-notification>
```

O ledger é escrito pela extensão, não pelo modelo:
`.foreman/runs/<run-id>/ledger.log` (mais `.foreman/plan-runner/<slug>/progress.md`
quando um `plan_slug` é informado) recebe uma linha por tarefa, acrescentada
*antes* de a notificação ser entregue. O modo `--print` não consegue receber
despertares (o processo termina quando o agente assenta); use `--mode rpc` ou a
TUI interativa.

Parâmetros de `foreman_delegate`:

| Parâmetro | Tipo | Notas |
|---|---|---|
| `role` | enum | `planner`, `frontend-dev`, `backend-dev`, `qa`, `qa-bugfix`, `plan-step-builder`, `codebase-auditor`, `reviewer`, `shipper` |
| `handoff_prompt` | string | Prompt completo e autocontido para o worker. |
| `plan_step` | número, opcional | Passo do plano a que a tarefa pertence (ledger). |
| `plan_slug` | string, opcional | `docs/plans/<slug>.md`; o primeiro valor não vazio fica fixado para a execução. |

## Papéis (roles)

Definidos uma única vez em `lib/roles.ts`. O diretório `agents/` tem um arquivo por papel: `planner`, `frontend-dev`, `backend-dev`, `qa`, `qa-bugfix`, `plan-step-builder`, `codebase-auditor`, `reviewer`, `shipper`.

| Papel | Tier | O que faz |
|---|---|---|
| `planner` | strong | Lê o projeto e produz um plano estruturado. Somente leitura. |
| `frontend-dev` | mid | Implementa trabalho de interface. |
| `backend-dev` | mid | Implementa trabalho de backend. |
| `qa` | cheap | Testa e verifica; escreve apenas em `.foreman/`. |
| `qa-bugfix` | mid | Corrige bugs encontrados pelo QA. |
| `plan-step-builder` | mid | Constrói um passo de um plano aprovado (perfil mais leve do worker-guard). |
| `codebase-auditor` | cheap | Auditoria somente leitura; escreve apenas `.foreman/` e `FOREMAN_AUDIT.md`. |
| `reviewer` | strong | Revisa mudanças. Somente leitura. |
| `shipper` | mid | Faz commit, push e abre PRs; escreve apenas em `.foreman/`. |

O papel de release da 0.1.x foi substituído por `shipper`, sem alias para o nome
antigo.

## Tiers de modelo e variáveis de ambiente

Os agentes declaram `tier: strong|mid|cheap` e
`thinking: off|minimal|low|medium|high|xhigh|max` no frontmatter. Nenhum id de
modelo é distribuído; valores inválidos são ignorados. `lib/model-policy.ts`
os resolve quando um worker é criado e registra a escolha como
`model`/`thinking` no JSON de meta de cada tarefa.

- Modelo: `FOREMAN_MODEL_<ROLE>` > `model:` do frontmatter > `FOREMAN_MODEL_<TIER>` >
  herda o modelo da sessão (assim `foreman/hybrid` passa sem alteração).
- Thinking: `FOREMAN_THINKING_<ROLE>` > `thinking:` do frontmatter > o nível de
  thinking da sessão.

`<ROLE>` é o nome do agente em maiúsculas com `_` (`plan-step-builder` vira
`PLAN_STEP_BUILDER`); `<TIER>` é `STRONG`, `MID` ou `CHEAP`. Exemplo:
`FOREMAN_MODEL_STRONG=anthropic/claude-opus-4` afeta apenas os papéis do tier
strong. Um modelo explícito contorna a camada de fallback do `foreman/hybrid`.

| Variável | Padrão | Significado |
|---|---|---|
| `FOREMAN_LANG` | de `LC_ALL`/`LC_MESSAGES`/`LANG` | Idioma da UI: `en` ou `pt-BR`. Veja "Idioma". |
| `FOREMAN_PI_MODE` | não definida | `orchestrator` força o modo ligado, `off` força desligado (RPC, print, execuções ao vivo). |
| `FOREMAN_MODEL_<ROLE>` / `FOREMAN_MODEL_<TIER>` | não definidas | Sobrescrita de modelo por papel ou tier. |
| `FOREMAN_THINKING_<ROLE>` | não definida | Sobrescrita do nível de thinking por papel. |
| `FOREMAN_MAX_WORKERS` | 4 | Workers simultâneos; delegações extras entram na fila. |
| `FOREMAN_BATCH_MS` | 300 | Janela de debounce para agrupar conclusões. |
| `FOREMAN_WORKER_TIMEOUT_MS` | 1800000 (30 min) | Timeout por worker (0 desativa). |
| `FOREMAN_ABORT_WAIT_MS` | 7000 | Quanto o `/foreman off` espera os workers pararem após a confirmação. |
| `FOREMAN_KEEP_MODE_TIMEOUT_MS` | 30000 | Quanto o aviso de retomada/fork "manter o modo orquestrador?" espera. |
| `FOREMAN_CONTEXT_PRUNE` | true | `false` desativa a poda de notificações. |
| `FOREMAN_CONTEXT_KEEP_PER_ROLE` | 1 | Resultados concluídos mantidos por papel. |
| `FOREMAN_CONTEXT_DEBUG` | desligada | `1` registra no stderr as contagens antes/depois/podadas. |
| `FOREMAN_PRIMARY_MODEL` / `FOREMAN_FALLBACK_MODEL` | `claude-sonnet-4-5` / `gpt-4o-mini` | Ids de modelo do `foreman/hybrid`. Veja "Fallback de modelo". |
| `FOREMAN_PI_SUBAGENT`, `FOREMAN_PI_ROLE` | definidas pelo spawner | Marcam um processo de worker e seu papel. Não devem ser definidas à mão. |

## Contrato de relatório do worker

Todo worker termina sua mensagem final com este bloco. Apenas as palavras-chave
em inglês são interpretadas; o texto dentro dos campos pode estar em qualquer
idioma.

```
--- foreman-report ---
Status: completed|failed|blocked
Summary: ...
Files: ...
Rulings: ...
Blocked-on: ...
--- end foreman-report ---
```

O último bloco bem formado vence. A notificação carrega os campos
interpretados mais um valor `contract`: `ok`, `missing` (relatório não vazio sem
bloco) ou `malformed` (havia um bloco, mas inutilizável). Uma primeira linha
`[BLOCKED]` legada ainda significa bloqueado. `failed` também cobre saída
diferente de zero, sinal, timeout, erro ao criar o processo ou saída vazia. O
relatório completo está sempre no caminho `output`.

## Estado do modo

O modo orquestrador é estado de sessão, não um arquivo. Ele vem, em ordem, de:

1. `FOREMAN_PI_SUBAGENT=1`: sempre inativo (workers nunca são restringidos).
2. `FOREMAN_PI_MODE`: `orchestrator` ou `off` força o estado.
3. A entrada de sessão `foreman-mode` persistida mais recente (também anunciada
   no barramento de eventos `foreman:mode`), de modo que o modo sobrevive a
   `/reload`, retomada e fork.
4. Padrão: inativo.

Uma sessão nova (`startup` ou `new`) sempre começa inativa. Ao retomar ou fazer
fork de uma sessão que estava no modo, o usuário é perguntado se quer mantê-lo;
sem resposta, o estado restaurado é mantido. Veja
[references/orchestrator-mode.md](references/orchestrator-mode.md).

## Worker guard

`extensions/worker-guard/` limita o que cada worker pode escrever. O spawner
define `FOREMAN_PI_ROLE=<role>` junto com `FOREMAN_PI_SUBAGENT=1`; o guard
confere cada chamada `write`, `edit` e `bash` de um worker contra o seu papel
(`qa` e `codebase-auditor` apenas `.foreman/**` e `FOREMAN_AUDIT.md`, `planner`
e `reviewer` somente leitura, `shipper` apenas `.foreman/`, papéis de
desenvolvimento em qualquer lugar do repositório exceto `.git/`, caminhos fora
dele e arquivos `.env` reais). Um papel desconhecido falha fechado para somente
leitura, e o guard fica inativo sem as duas variáveis de ambiente.

**Limites honestos.** É uma heurística, não um sandbox: ele analisa texto de
shell, então interpretadores, `make`, `npm run` e scripts ainda podem escrever
em qualquer lugar, e um caminho pode mudar entre a verificação e a escrita. Ele
não impede um modelo de reportar resultados errados. Política completa e
limites: [references/worker-guard.md](references/worker-guard.md).

## Idioma

As strings de UI da extensão (descrições de comandos, notificações, barra de
status, widget, `/foreman-status`) vêm de `lib/i18n.ts`, em inglês ou português
do Brasil. O Pi não tem configuração de locale, então o locale é detectado a
partir do ambiente: `FOREMAN_LANG`, depois `LC_ALL`, `LC_MESSAGES`, `LANG` (o
primeiro não vazio vence; `pt*` resulta em `pt-BR`, `en*` e qualquer outro
valor resultam em `en`). Um `FOREMAN_LANG` inválido é ignorado.

O locale da UI e o idioma da conversa são coisas separadas. A UI segue o locale
do ambiente. A conversa com o agente segue o idioma das suas mensagens: as
skills e os agentes instruem o modelo a responder no seu idioma. Prompts,
motivos do guardrail, blocos de notificação e as palavras-chave do contrato de
relatório permanecem em inglês. Se você escreve para o agente em português mas
o seu `LANG` é inglês, defina `FOREMAN_LANG=pt-BR` para ter a UI em português.

## Fallback de modelo

Esta seção existe só em inglês, para não manter uma segunda cópia do texto que
possa divergir. Veja a seção
["Model fallback (false-positive testing, not a refusal bypass)"](README.md#model-fallback-false-positive-testing-not-a-refusal-bypass)
no [README.md](README.md).

## Filtro de contexto

`extensions/context-filter/` se conecta ao evento `context` (o pi entrega um
clone, então a transcrição armazenada não é alterada) e remove mensagens
`foreman-task-notification` antigas, para que orquestrações longas não acumulem
todos os relatórios de worker. Apenas essas mensagens estão no escopo. Ele
mantém os `FOREMAN_CONTEXT_KEEP_PER_ROLE` resultados concluídos mais recentes
por papel, mais todos os blocos da última notificação; blocos `failed` e
`blocked` nunca são podados; os blocos podados se reduzem a uma linha por papel
(`[pruned: K older <role> results — recover: <output paths>]`).

## Testes e CI

```bash
npm install
npm test               # typecheck + todos os testes smoke/lint (os scripts live-* são separados)
npm run test:package   # empacota, instala em um sandbox, confere a descoberta
```

O `npm test` inclui `test:readme`, que verifica que a seção Model fallback do
README em inglês é idêntica byte a byte à da `main`, que as listas de papéis e
comandos nos dois READMEs batem com o código, e que nenhuma referência obsoleta
(o papel de release removido, o dispatcher vendorizado removido, o arquivo marcador removido) sobra fora
dos documentos históricos. Os scripts `test:live:*` usam um `pi` real e são
executados à mão. O CI (`.github/workflows/ci.yml`) roda `npm ci`, typecheck,
`npm test` e a verificação do pacote a cada push e pull request.

Antes de lançar, rode a verificação de carga a partir de um diretório
temporário:

```bash
cd /tmp && mkdir -p pi-verify && cd pi-verify
timeout 20 pi --no-session --print --verbose "hi" 2>&1 | grep -iE "error|failed to load"
```

Sem saída significa que as extensões carregaram sem erro. As notas históricas
de verificação ao vivo do port 0.1.x estão em
[docs/verification-log.md](https://github.com/MTBasso/foreman-pi/blob/main/docs/verification-log.md) (em inglês).

## Estrutura

```
PLAN.md                  notas de design e status das fases
CHANGELOG.md             notas de lançamento (inglês)
extensions/              foreman-mode, orchestrator-guardrail, coordination,
                         context-filter, session-reminder, worker-guard, model-fallback
lib/                     módulos compartilhados e seus testes
agents/                  as 9 definições de worker
skills/                  foreman, plan-runner, project-memory, design-preview
references/              documentos de apoio para os quais as skills apontam
templates/               template do prompt de handoff
scripts/                 check-package.ts
docs/                    plans/ e verification-log.md
```

## Licença

MIT, igual ao [`foreman`](https://github.com/MTBasso/foreman) original.
