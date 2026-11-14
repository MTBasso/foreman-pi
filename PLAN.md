# Plano: recriar o workflow do foreman (Claude Code) no Pi

Este repositório guarda o **plano**, não a implementação ainda. Objetivo:
recriar o workflow do plugin [`foreman`](https://github.com/MTBasso/foreman)
— um orquestrador que grila, planeja, constrói, testa e lança, sempre
delegando a sub-agentes e nunca editando código diretamente — no
[Pi](https://github.com/earendil-works/pi) (`@mariozechner/pi-coding-agent`
ou `@earendil-works/pi-coding-agent`, nomes de pacote têm mudado).

Pesquisa de viabilidade feita em 2026-11-10, direto na doc oficial
(`packages/coding-agent/docs/extensions.md` e
`examples/extensions/subagent/README.md` do repo `earendil-works/pi`).
Fontes citadas inline onde relevante.

## Veredito

**Dá pra fazer.** O Pi tem os dois primitivos que o foreman depende:
um hook que pode negar uma chamada de tool antes de executar, e um jeito de
rodar sub-agentes com acesso a tools restrito por definição. Mas é um
**port de engenharia real**, não uma cópia de arquivo — a casca inteira
(hooks em bash+jq, pacote `.claude-plugin/`, comandos de slash) é
específica do Claude Code e precisa ser reescrita em TypeScript no formato
de extensão do Pi.

## Diferenças de arquitetura que importam

### 1. Guardrail (bloquear Write/Edit/Bash enquanto orquestrador ativo)

No foreman hoje: hook `PreToolUse` em bash, roda no mesmo processo,
distingue orquestrador de sub-agente pelo campo `agent_id` no payload do
hook (presente quando quem chamou é um sub-agente via `Agent`/`Task` tool).

No Pi: o evento `tool_call` **pode bloquear** — handler roda depois de
`tool_execution_start` e antes da execução, e retorna
`{ block: true, reason?, terminate? }`. Confirmado na doc, com exemplo:

```typescript
if (isToolCallEventType("bash", event) && event.input.command.includes("rm -rf")) {
  const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
  if (!ok) return { block: true, reason: "Blocked by user" };
}
```

Só que a distinção orquestrador-vs-sub-agente **não existe como campo** no
Pi, porque não precisa existir: cada sub-agente roda como **processo `pi`
separado**, com seu próprio conjunto de tools definido no frontmatter do
agente (`tools: read, grep, find, ls, bash`). Então a restrição de escrita
do orquestrador é um problema só do processo do orquestrador, resolvido com
`pi.setActiveTools(names)` (desativar `write`/`edit`/`bash`-que-escreve
enquanto o estado "modo orquestrador" estiver ligado) **e/ou** o mesmo
bloqueio reativo via `tool_call`, como camada de segurança redundante —
não precisa adaptar nada pra sub-agente, porque o sub-agente, sendo outro
processo, nunca carrega essa restrição em primeiro lugar (ele carrega o seu
próprio `tools:` do frontmatter dele).

**Vantagem real sobre o modelo atual do Claude Code**: `setActiveTools` é
proativo (a tool nem aparece como disponível), não reativo
(deixar a tool aparecer e negar a chamada depois).

### 2. Sub-agentes / delegação

Não é core do Pi — é um **exemplo de extensão da comunidade**
(`examples/extensions/subagent/`), não funcionalidade oficial mantida.
Formato do agente:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---
```

Mapeia quase 1:1 com os `agents/*.md` do foreman hoje (nome, descrição,
tools, modelo opcional — se omitido, herda o da sessão que despachou).
Riscos documentados:

- Cada sub-agente é processo `pi` separado — Ctrl+C no pai propaga
  `SIGTERM`/`SIGKILL` pros filhos.
- Contexto do filho é isolado (não soma ao uso de tokens da sessão pai, só
  aparece nos detalhes da chamada de tool).
- Resultado de volta ao pai é truncado (50 KB / 2.000 linhas por tarefa).
- **Esse exemplo é uma dependência de terceiro, não parte garantida do
  core** — decisão a tomar: adotar/fazer fork dele, ou escrever um
  dispatcher próprio no mesmo padrão (provavelmente a opção mais segura a
  longo prazo, dado que é pouco código e evita depender de um exemplo que
  pode mudar de formato sem aviso).

### 3. Reminder de sessão (equivalente ao `SessionStart` hook atual)

Esse foi o ponto que exigiu mais pesquisa. No Claude Code, o hook
`SessionStart` dispara uma vez e pode devolver `additionalContext` direto
pro modelo. **No Pi não existe equivalente 1:1**:

- `session_start` dispara uma vez por sessão
  (`event.reason: "startup" | "reload" | "new" | "resume" | "fork"`), mas
  **não tem retorno documentado** — não injeta nada no contexto do modelo.
- `before_agent_start` é quem injeta contexto de fato
  (`return { message, systemPrompt }`), mas dispara **em toda execução**,
  não só na primeira.

**Padrão documentado pela própria Pi** (usado no exemplo oficial da doc,
variável `addedReviewReminder`): combinar os dois hooks com uma flag em
closure.

```typescript
let pendingSessionReminder: string | null = null;

pi.on("session_start", async (event, ctx) => {
  // event.reason: "startup" | "reload" | "new" | "resume" | "fork"
  if (fs.existsSync(".orchestrator-active") &&
      (event.reason === "startup" || event.reason === "new")) {
    pendingSessionReminder = "...marcador .orchestrator-active já existe, " +
      "pode ser lixo de sessão anterior...";
  }
});

pi.on("before_agent_start", async (event, ctx) => {
  if (pendingSessionReminder && event.messageType === "user") {
    const msg = pendingSessionReminder;
    pendingSessionReminder = null; // só injeta uma vez
    return { message: { customType: "foreman-reminder", content: msg, display: true } };
  }
});
```

Isso cobre tanto o aviso padrão ("este projeto tem o foreman, use /foreman
pra feature nova...") quanto a detecção de marcador obsoleto que acabamos
de adicionar no plugin original (CHANGELOG 0.6.1/0.6.2 do `foreman`).

### 4. Comandos de slash (`/foreman-status`, `/foreman-audit`, etc.)

`pi.registerCommand("name", { ... })` — confirmado na doc, mapeamento
direto.

### 5. Skills (`SKILL.md`)

Pi já lê skills de `.pi/skills/` (projeto) ou `~/.pi/skills/` (pessoal),
descoberta por descrição no startup, carregamento completo quando
relevante — mesmo espírito do Skill tool do Claude Code. Conteúdo das
`SKILL.md` atuais (foreman, plan-runner, design-preview, project-memory)
porta quase direto; só o frontmatter pode precisar de ajuste de campo.

### 6. Empacotamento/distribuição

`.claude-plugin/marketplace.json` + `plugin.json` são convenção do Claude
Code. No Pi, skills/extensões são descobertas via `.pi/skills/`,
`.pi/agents/`, ou declaradas em `pi.skills` no `package.json` de um pacote
npm. Precisa decidir: distribuir como pacote npm instalável (mais parecido
com o fluxo atual via marketplace), ou como arquivos pra colar direto no
`.pi/` do projeto (mais simples, menos "produto").

## Mapeamento resumido

| Foreman hoje (Claude Code)              | Equivalente no Pi                                           |
|------------------------------------------|---------------------------------------------------------------|
| `skills/*/SKILL.md`                      | `.pi/skills/*/SKILL.md` — quase cópia direta                 |
| `agents/*.md`                            | `.pi/agents/*.md` com `tools:` no frontmatter — mapeamento direto |
| `hooks/block-edit-during-orchestrator.sh`| extensão TS: `pi.on("tool_call", ...)` + `pi.setActiveTools()` — reescrita |
| `hooks/session-start.sh`                 | extensão TS: `pi.on("session_start", ...)` + `pi.on("before_agent_start", ...)` coordenados — reescrita |
| `commands/*.md`                          | `pi.registerCommand(...)` — reescrita |
| `.claude-plugin/*.json`                  | `package.json` com `pi.skills`, ou arquivos soltos em `.pi/` — a decidir |
| sub-agentes via `Agent`/`Task` tool      | processos `pi` separados via extensão de subagent (comunidade ou própria) |

## Perguntas abertas antes de codar

1. **Dispatcher de sub-agente**: adotar o exemplo `examples/extensions/subagent/`
   como dependência, ou escrever o nosso (mais controle, menos risco de
   breaking change de terceiro)?
2. **Formato de distribuição**: pacote npm vs. arquivos soltos em `.pi/`?
3. **Paridade de `NotebookEdit`**: o Pi tem tool nativa pra notebook? Se
   não, o guardrail nem precisa cobrir esse caso — mas falta confirmar o
   conjunto de tools nativas do Pi (`read`, `write`, `edit`, `bash`, e mais
   o quê).
4. **`pi.appendEntry()` / `ctx.sessionManager.getEntries()`**: dá pra usar
   isso como ledger persistente (equivalente ao
   `.foreman/plan-runner/<slug>/progress.md` atual, ou ao ledger novo que
   recomendamos pro `foreman` em si) em vez de — ou além de — um arquivo
   solto no repo? Vale investigar antes da Fase 3 abaixo.
5. **Confirmar nomes de pacote**: a doc/exemplos usam tanto
   `@mariozechner/pi-coding-agent` quanto `@earendil-works/pi-coding-agent`
   — confirmar qual é o atual antes de fixar instruções de instalação.

## Fases — status

Pesquisa de payload do `session_start`/`before_agent_start` e desenvolvimento
inicial feitos em 2026-11-10, direto contra `@earendil-works/pi-coding-agent@1.5.2`
instalado como devDependency deste repo (tipos reais de
`dist/core/extensions/types.d.ts`, exemplos reais em `examples/extensions/`)
— não apenas a doc resumida. Ver `README.md` e `docs/verification-log.md` pro estado de cada peça.

- **Fase 0 — prova de conceito do guardrail. ✅ feito E verificado ao vivo
  em 2026-11-11.** `extensions/orchestrator-guardrail/` implementa
  `tool_call` block + `setActiveTools`, com 13/13 checks de lógica passando
  (`npm run test:guardrail`) contra os tipos reais. Com `pi` 1.5.2 disponível
  neste ambiente, rodamos sessões `pi --no-session -p --mode json` reais
  (não apenas os fakes do smoke test) carregando a extensão via `--extension`
  contra um diretório sandbox com `.orchestrator-active` presente, e
  confirmamos ao vivo:
  - `write` chamado pelo modelo retorna `"Tool write not found"` — a camada
    proativa (`setActiveTools` em `turn_start`) já removeu a tool antes do
    modelo tentar.
  - `edit` igualmente ausente; o modelo cai de volta pra `read`.
  - `bash` com `sed -i`, `printf ... > arquivo` e `echo ... > arquivo` são
    bloqueados pela camada reativa (`tool_call`), com a razão exata do
    `index.ts` devolvida como erro da tool.
  - **Bug real encontrado e corrigido**: `ALLOWED_BASH_TARGET_PATTERNS`
    incluía `.txt`/`.out` como "redirect de spot-check seguro" — isso deixava
    `echo hacked > existing.txt` passar direto, sobrescrevendo o arquivo de
    verdade (confirmado: o conteúdo virou `hacked`). `.txt` é um formato de
    conteúdo real, não um sinal confiável de "é só log". Corrigido pra só
    `.log` e `/dev/null`; teste de regressão adicionado no smoke test com o
    comando exato que vazou.
- **Fase 1 — portar skills. ✅ feito.** `SKILL.md` de `foreman`, `plan-runner`,
  `design-preview`, `project-memory` copiados pra `skills/` (convenção de
  pacote do Pi, descoberta automática sem manifesto — ver `packages.md`).
  Menções específicas do Claude Code (Artifact tool, `PreToolUse`,
  `NotebookEdit`, "Agent tool"/"create a new session") reescritas pros
  primitivos reais do Pi.
- **Fase 2 — portar agentes + dispatcher de sub-agente. ✅ feito E
  verificado ao vivo em 2026-11-11** (ver `README.md`, "Why adopt the
  example"). Decisão da pergunta aberta 1: adotar
  `examples/extensions/subagent/` (copiado pra `extensions/subagent-dispatch/`)
  em vez de escrever do zero, com uma mudança funcional documentada (agentes
  empacotados em `agents/*.md` são descobertos junto dos de usuário/projeto,
  `source: "package"`). 8 agentes portados (`backend-dev`, `frontend-dev`,
  `qa`, `qa-bugfix`, `planner`, `plan-step-builder`, `release-manager`,
  `codebase-auditor`), confirmados descobertos pelo dispatcher real
  (`npm run test:agents`).

  Verificação ao vivo: um `pi --no-session -p --mode json` real, só com
  `extensions/subagent-dispatch/` carregada, chamou a tool `subagent` com
  `agent: "planner"`, confirmamos no log JSON (`message_end` com
  `role: "toolResult"`) que um processo `pi` filho de fato subiu, rodou o
  agente `planner` ported, leu `package.json` e devolveu o `name` correto
  (`foreman-pi`) pro processo pai — não é só "a lógica de discovery passa no
  smoke test", é "o subprocesso sobe e volta com resultado real". `agentScope`
  só aceita `"user"|"project"|"both"` (não `"package"`), mas isso não importa:
  agentes do pacote carregam independente do scope (ver `agents.ts`).

  **Bug real encontrado e corrigido** durante o teste de integração completo
  (guardrail + dispatch juntos, Fase 3 abaixo): o processo filho do dispatcher
  **também** carregava `orchestrator-guardrail` por padrão — porque este
  repo está instalado como pacote (`~/.pi/agent/settings.json`), a descoberta
  automática de extensões do Pi carrega as extensões do pacote em *toda*
  invocação de `pi` na máquina, não só na sessão explicitamente marcada como
  orquestradora. O filho compartilha o cwd do pai, então via o mesmo
  `.orchestrator-active` e teve sua própria `edit` tool removida no meio da
  tarefa — contradizendo a suposição documentada ("sub-agente, sendo outro
  processo, nunca carrega essa restrição"). `--no-extensions` no filho não
  serve de solução geral: nenhum dos 8 agentes porta `model:` próprio, então
  todos herdam o modelo da sessão pai — que nesta instalação é o modelo
  virtual `foreman/hybrid` do `model-fallback`, que só existe se as extensões
  do pacote carregarem. Corrigido com uma flag de ambiente
  (`FOREMAN_PI_SUBAGENT=1`, setada pelo `spawn()` do dispatcher) que o
  guardrail usa pra nunca se considerar ativo num processo filho, marcador
  ou não. Confirmado ao vivo: com o fix, um `frontend-dev` sub-agente editou
  `greet.js` com sucesso enquanto `.orchestrator-active` seguia presente no
  diretório.
- **Fase 3 — portar o guardrail completo + reminder de sessão. ✅ feito.**
  `extensions/session-reminder/` combina `session_start` (detecta marcador
  obsoleto num `startup`/`new`) + `before_agent_start` (injeta o aviso uma
  vez), como documentado na seção 3 abaixo. `references/orchestrator-marker.md`
  e `references/guardrail-troubleshooting.md` reescritos pra terminologia
  do Pi.

  **Ciclo completo verificado ao vivo em 2026-11-11** (guardrail +
  subagent-dispatch juntos, numa sessão `pi --no-session -p --mode json`
  real, cwd compartilhado com `.orchestrator-active` presente):
  1. Modelo tenta `edit` → tool ausente (removida proativamente); tenta
     `bash` com redirecionamento → bloqueado reativamente com a razão do
     `index.ts`.
  2. Modelo chama `subagent` (`agent: "frontend-dev"`, `agentScope: "both"`).
  3. O processo filho real sobe, lê `greet.js`, chama sua própria `edit` tool
     — e, com o fix `FOREMAN_PI_SUBAGENT` da Fase 2, a edição é aplicada de
     verdade: `greet.js` ganhou a linha `// greeting helper` no disco, com
     `.orchestrator-active` presente durante todo o teste.
  4. O resultado (sucesso/falha da edição) volta pro processo pai via stdout
     JSON do filho, igual ao teste da Fase 2.

  Nuance observada, não um bug: sem uma instrução explícita dizendo "o
  marcador não te afeta, prossiga", o modelo rodando como sub-agente às vezes
  prefere perguntar ("devo apagar o marcador?") em vez de agir, por cautela
  genérica sobre um arquivo de convenção que ele reconhece do próprio
  treinamento — isso é julgamento do modelo, não a extensão bloqueando nada
  (confirmado comparando os dois casos: quando a extensão de fato bloqueia,
  a tool resultante é removida/nega com a razão do `index.ts`; quando é só
  cautela do modelo, não há remoção de tool nem `isError`, só um texto
  perguntando). Vale uma frase no prompt do `foreman`/`plan-runner` deixando
  isso explícito pro sub-agente nunca precisar adivinhar.
- **Fase 4 — portar comandos de slash. ✅ feito na 0.2.0.** `/foreman`,
  `/foreman off`, `/foreman-status`, `/foreman-audit`, `/foreman-diagnose`,
  `/plan-runner` via `pi.registerCommand(...)`, com barra de status e widget.
  Nota de design: o modo é estado de sessão (entrada `foreman-mode`, evento
  `foreman:mode`, override `FOREMAN_PI_MODE`); `/foreman off` só aborta
  workers após confirmação explícita e recusa sem UI.
- **Fase 5 — empacotamento. ✅ feito na 0.2.0.** Manifesto `pi` +
  `files`/`engines` no `package.json`; `npm run test:package` empacota o
  tarball, roda `pi install` + `pi list` num sandbox e confirma a descoberta
  (skills, comandos, agentes, `foreman hybrid`). CI no GitHub Actions.
  Nota de design: o sandbox usa `HOME` e `PI_CODING_AGENT_DIR` temporários e
  confere que o `settings.json` real não mudou.
- **Fase 6 — paridade de testes. ✅ feito na 0.2.0.** `npm test` encadeia
  typecheck e os testes de guardrail, worker-guard, agentes, spawn, política
  de modelo, i18n, README/docs, modo, comandos, fallback, coordenação, filtro
  de contexto, lembrete e instruções; os scripts `test:live:*` seguem manuais.
  Nota de design: o teste de README confere a seção de fallback byte a byte
  contra a `main` (com sha256 fixado para checkouts rasos) e as listas de
  papéis/comandos contra o código.

### Nota de 2026-11-11: remoção do dispatcher e do marcador (0.2.0)

- O dispatcher vendorizado `extensions/subagent-dispatch/` foi removido; a
  descoberta de agentes e o spawn de `pi` filho vivem em `lib/agents.ts` e
  `lib/spawn.ts`, usados por `extensions/coordination/` (`foreman_delegate`).
  O agente `release-manager` virou `shipper`, sem alias, e ganhou o par
  `reviewer`. O "quirk de typecheck" abaixo diz respeito ao dispatcher e hoje
  é só histórico.
- O arquivo `.orchestrator-active` foi removido por completo: nada mais o lê
  ou escreve. O modo orquestrador é estado de sessão (ver Fase 4). As
  descrições de marcador nas Fases 0 a 3 acima são o registro histórico do
  que foi verificado ao vivo na 0.1.x; o texto completo dessa verificação
  está em `docs/verification-log.md`. Um arquivo antigo que sobrar é ignorado
  e pode ser apagado.

## Descoberta de desenvolvimento: quirk de typecheck no dispatcher adotado

`extensions/subagent-dispatch/index.ts` (código upstream, não nosso) falha
o `tsc --noEmit` em dois pontos (`params.agentScope ?? "user"`) com
`Type '{}' is not assignable to type 'AgentScope'`, em qualquer versão de
TypeScript testada (7.0.2 e 5.9.3) — não é um problema de versão do
compilador. É o tipo `Static<>` do `typebox`/`StringEnum` não resolvendo
igual fora do runtime real do Pi: a doc de extensões já avisa que "Pi maps
these imports to its own copies, so extensions share Pi's classes and
registries" — ou seja, nosso `npm install` local resolve um `typebox`
separado do que o `pi` real remapearia via `jiti` em tempo de execução, e
só nesse cenário local isolado a inferência quebra. Não é um bug de lógica
(o `jiti` do Pi não faz type-check, só transpila) — é só o nosso harness de
desenvolvimento não replicando o remapeamento de módulos do Pi. Documentado
e excluído do `tsc` estrito do nosso `tsconfig.json` (ver comentário lá);
não alteramos a linha em si pra manter o diff vendorizado limpo.

## Fora do escopo original: fallback de modelo pra teste de falso positivo

Fora das 6 fases acima (que portam o `foreman` original), adicionamos
`extensions/model-fallback/` a pedido do usuário, pra testar se uma recusa
do Claude num projeto específico é falso positivo. Decisões importantes,
registradas aqui porque vieram de uma negociação explícita na conversa:

- **O que foi recusado**: um roteador que, ao ver uma recusa do Claude,
  repassa pra um modelo "refuseless" (sem salvaguardas) — isso é bypass de
  recusa por construção, independente de como a intenção é descrita, e não
  foi implementado.
- **O que foi implementado**: fallback pra GPT (provedor comum, com sua
  própria política de segurança). Se o GPT também recusar, a extensão para
  — sem escalar pra um terceiro modelo. Ver `README.md`, seção "Model
  fallback", pra essa distinção por completo.
- **Mecanismo confirmado** contra `docs/virtual-models.md` e
  `examples/extensions/jev-router.ts` reais do pacote instalado:
  `registerVirtualModel` com `route()` *sem estado* — decide reolhando a
  cauda de `request.messages` desde a última mensagem de usuário, em vez de
  carregar estado entre chamadas (mesmo padrão do `editedThisTurn` do
  `jev-router.ts`). `agent_end` detecta a recusa e `agent_settled` (ponto
  documentado como seguro pra isso) dispara o retry via
  `pi.sendMessage(..., {triggerTurn:true})`.
- **Bloqueio prático real**: GPT via API exige chave da OpenAI com billing
  — a assinatura do ChatGPT (grátis ou Plus) não dá acesso à API. O usuário
  mencionou só ter o plano grátis do ChatGPT; isso precisa ser resolvido
  (chave de API própria) antes de qualquer teste ao vivo.
- 8/8 checks de lógica passam (`npm run test:fallback`), incluindo um teste
  específico pra garantir que uma resposta longa e legítima contendo "I
  can't" no meio do texto não é confundida com recusa.

## Coordinator: event-driven delegation (decision + tradeoffs)

Plano aprovado: `docs/plans/foreman-pi-event-driven-coordinator.md` (branch `feat/event-driven-coordinator`, uma fase por commit).

**Por quê.** O `subagent` adotado bloqueia o orquestrador dentro da chamada da ferramenta até o filho terminar: sem paralelismo real entre turnos, sem como reagir a um worker que termina cedo e, no `pi-claude-cli`, cadeias longas de tool calls são instáveis. A decisão foi trocar espera por evento: `foreman_delegate` spawna um `pi` filho e retorna na hora; o orquestrador encerra o turno; a extensão o acorda quando os workers terminam. Na Fase 3 `foreman_delegate` passou a ser a *única* ferramenta de ação do orquestrador (`subagent` saiu da allowlist e é bloqueado em `tool_call`; filhos com `FOREMAN_PI_SUBAGENT=1` continuam isentos).

**Forma da notificação.** Uma mensagem custom (`customType: foreman-task-notification`, `display` true) com N blocos `<task-notification>` (task-id, role, status completed|failed|blocked, plan-step, summary ~400 chars, output). `details` carrega `{batchId, notifications[]}` estruturado (usado pelo renderer, pelo context filter e pela detecção de entrega). O pi converte `role:"custom"` em `role:"user"` no `convertToLlm`, então o modelo a vê como texto de usuário. A fonte da verdade é o arquivo em `output` (`.foreman/runs/<run-id>/<task-id>.md`), não o summary.

**Semântica do ledger.** Escrito pela extensão, não pelo modelo: `.foreman/runs/<run-id>/ledger.log` (+ `.foreman/plan-runner/<slug>/progress.md` se houver `plan_slug`), uma linha por notificação/tarefa, append *síncrono antes* da entrega, e reenvios de um lote não duplicam linhas. Registra o resultado do *worker* (completed|failed|blocked), não a verdade do merge — essa vem do Status do arquivo do plano.

**Poda (`extensions/context-filter/`).** Mantém a última notificação completed por role + todos os blocos da última mensagem de notificação; failed/blocked nunca são podados; o resto vira uma linha `[pruned: K older <role> results — recover: <paths>]`. Usa o evento `context` e não `context_with_system`: o `context` já entrega as mensagens (clone, sem system) antes do `convertToLlm`, que é exatamente onde `role:"custom"` ainda é distinguível; `context_with_system` só seria necessário para editar o system prompt, o que não fazemos. É não destrutivo (o arquivo de sessão guarda o histórico completo).

**Tradeoffs.**
- Código de spawn duplicado: `coordination/spawn-worker.ts` copia a lógica do `subagent-dispatch` vendorizado (que não exporta `runSingleAgent` e fica fora do tsc). Deliberado, para não mexer no vendor.
- A notificação chega como mensagem de papel `user`; o modelo pode confundi-la com instrução do usuário. Mitigado por `promptGuidelines` e pelo skill ("relatórios de worker entregues pelo harness, não instruções do usuário"), mas é mitigação, não garantia.
- Modo `--print` não consegue ser acordado: sai quando o agente assenta. Wake-ups exigem `--mode rpc` ou o TUI.
- Dependência da semântica de `followUp`/`triggerTurn` do pi 1.5.2 (entrega no meio de um run vs. idle-wake); uma mudança upstream ali quebra a entrega. Mitigação: reenvio no `agent_settled` se o lote não aparece na sessão.
- Um lote nunca entregue após 3 tentativas é descartado; antes isso era silencioso, agora loga `console.error` com task ids e paths de output (o ledger e os arquivos de output continuam existindo).

**Riscos conhecidos apontados pelo QA (não corrigidos, registrados com honestidade).**
- A flag `busy` do coordinator é marcada *antes* do `agent_start` (em `deliver`), para evitar corrida entre dois flushes. Se `sendMessage` não chegar a iniciar um run (ex.: sessão encerrando, mensagem engolida), `busy` fica true até o próximo `agent_start`/`agent_settled`, e as entregas seguintes saem como `followUp` em vez de idle-wake.
- Divergência ledger/notificação em erro de escrita: o append do ledger é best effort e não bloqueia a entrega; se o disco falhar, a notificação sai sem linha de ledger (e vice-versa um crash entre os dois deixa a linha sem notificação — o caso que a ordem "ledger antes" favorece de propósito).
- Lacuna de verificação na Fase 3: ao vivo, a chamada a `subagent` falhou com "Tool subagent not found" (a ferramenta nem está ativa), então o *bloqueio* em `tool_call` só é exercitado pelo smoke test com chamada fabricada, não ao vivo. `codemode`/`tool_search` aparecem em `getAllTools()` mas não no conjunto ativo; não foi verificado se alguma via de codemode alcançaria `subagent`.

## Architecture & Token Efficiency Audit Improvements

Written 2026-11-14 (English; the rest of this file is pt-BR). Plan only: no application code was changed. Inputs: the external sources listed under "Fontes (audit)", the directAds export (`pi-session-2026-11-12T11-53-58-957Z_*.html`, plan-runner run of `docs/plans/readme-gap.md`) and its `.foreman/runs/*/*.events.jsonl`, and a read of this repo. Token figures below are measured from those artifacts (chars/4 where noted), not estimated from memory.

### Measured baseline (directAds run)

| What | Number |
|---|---|
| Orchestrator context growth | 24k tokens (turn 1) → 148k (end), 103 requests, no compaction, 7.4M cache-read + 2.4M cache-write tokens |
| Workers (6 roles, ~30 dispatches incl. retries) | ~25M cache-read tokens (de-duplicated); `plan-step-builder` 17.7M over 470 turns; planner 1.8M cache-read, ~86k output tokens over 48 turns (see A9) |
| `foreman` skill body injected by `/foreman` | ~6.4k tokens, re-read on every later orchestrator turn |
| `foreman_delegate` handoffs in orchestrator context | 44 calls × ~645 tokens = ~28k tokens that stay in context after dispatch |
| Orchestrator `read` results (worker reports, plan, templates) | 19 calls, ~26.7k tokens |
| System prompt of a session | ~8.5k tokens, of which 36 skill descriptions = ~4.3k (only 4 belong to foreman) |
| Notifications | 44 notifications, ~5.2k tokens total: the summary cap and `context-filter` already work |

### What already matches the research (keep)

- One action tool for the orchestrator (`foreman_delegate`, ~257 tokens) and a proactive `setActiveTools` restriction. Anthropic: "minimal viable set of tools"; no ambiguity about which tool to use.
- Sub-agent isolation with distilled returns: workers run as separate `pi` processes and return a ~400-char summary plus a report file on disk (just-in-time pointer, not raw output). Anthropic: sub-agents return 1-2k tokens.
- Notes outside the context window: `.foreman/runs/*/ledger.log`, `.foreman/plan-runner/<slug>/progress.md` (structured note-taking).
- `context-filter` prunes stale notifications (tool-result clearing, "safest lightest-touch compaction").
- Guard blocks name the reason and the report contract names `Blocked-on` (errors that let the agent self-correct).

### Items

Impact is the expected effect on reliability (R), maintainability (M) or tokens (T). Sources are in the list at the end of this section.

#### A. Token and context efficiency

**A1. Prune old `foreman_delegate` handoffs from the orchestrator context** (Impact: High, T)
- Gap: `context-filter` clears notifications but not the dispatch itself. Each `handoff_prompt` (avg 645 tokens, 44 of them) stays in the transcript and is re-read every turn, although the full text is already persisted in `.foreman/runs/<run>/<task>.json`. Anthropic ctx: "once a tool has been called deep in the message history, why would the agent need to see the raw result again"; just-in-time identifiers instead of inline data.
- Target files: `extensions/context-filter/index.ts` (+ `smoke-test.ts`), `extensions/coordination/index.ts` (ensure the run json keeps `handoff_prompt`).
- Task: in the `context` handler, for `foreman_delegate` tool calls that are not in the latest turn, replace `arguments.handoff_prompt` with `[handoff: .foreman/runs/<run>/<task>.json, <N> chars, role, plan_step]`. Keep `role`, `plan_slug`, `plan_step`. Non-destructive (session file keeps the original). Env switch `FOREMAN_CONTEXT_PRUNE_HANDOFFS=false`. Test: transcript with 5 dispatches → only the last keeps full text.

**A2. Stop the orchestrator from re-writing boilerplate in every handoff** (Impact: High, T+M)
- Gap: the handoff template makes the model re-emit the same blocks 44 times as output tokens: "About orchestrator mode" (~110 tokens, includes a historical anecdote), "User language", the guard "HARD RULE" lines (re-typed by hand in the session after each block), role blurb. writing-for-agents: single source of truth, no-ops, "cache" restating the environment. Anthropic: smallest set of high-signal tokens.
- Target files: `templates/handoff-prompt.md`, `extensions/coordination/coordinator.ts` / `spawn-worker.ts` (compose the prompt), `extensions/coordination/index.ts` (tool schema), `skills/foreman/SKILL.md` §4, `skills/plan-runner/SKILL.md`.
- Task: (1) the coordinator appends a fixed footer to every worker prompt (user language from `lib/i18n.ts`, "orchestrator mode does not apply to you", worktree path): the orchestrator writes only Role/Deliverable/Decided-context/Constraints deltas. (2) Template drops the anecdote and the role blurb (the agent file already carries the role). (3) The footer states the guard rules by pointing to `references/worker-common.md` (already appended to every worker) instead of restating them. (4) No `handoff_file` param for now: the orchestrator has no Write tool, so revisit only if A1 and A2 leave handoffs too large.
- Acceptance: median handoff ≤ 350 tokens on a replay of the readme-gap steps; worker output unchanged (compare reports on 3 replayed steps).

**A3. Custom compaction that keeps the run state** (Impact: High, R+T)
- Gap: no `session_before_compact` handler exists; the orchestrator reached 148k tokens, deep into what the AI Coding Dictionary calls the "dumb zone", and the user had to type `resume` six times. Anthropic ctx: compaction preserves architectural decisions and unresolved issues, discards redundant tool output; pi `docs/compaction.md`: `session_before_compact` can supply the summary.
- Target files: new `extensions/context-filter/compaction.ts` registered from `extensions/context-filter/index.ts`; `README.md` (settings section); `lib/mode.ts` if mode state needs to be restated.
- Task: build the summary from data we own instead of an LLM pass over everything: plan slug and path, worktree path and branch, per-step status table from `progress.md`/the plan's Status section, running/blocked/failed tasks with output paths, rulings made, user decisions (from FOREMAN_MEMORY.md), unresolved findings. Fall back to pi's default summary on any error. Document recommended `compaction.reserveTokens` / `modelOverrides` so compaction starts near 100k for the orchestrator.
- Verify: `smoke-test.ts` with a fake session; manual `/compact` in a real run keeps the next dispatch coherent.

**A4. Spawn workers without the user's global skills** (Impact: Medium, T+R)
- Gap: `lib/spawn.ts` starts workers with `--mode json -p --no-session` only. Each worker inherits every skill in `~/.agents/skills` (36 descriptions, ~4.3k tokens per request × ~700 worker requests ≈ 3M cached tokens) and can mis-trigger unrelated skills (tool confusion). pi `docs/cli.md`: `-ns, --no-skills`; `--skill <path>` loads explicit ones.
- Target files: `lib/spawn.ts` (args), `extensions/coordination/spawn-worker.ts`, `lib/spawn-test.ts`.
- Task: add `--no-skills` (opt-out `FOREMAN_WORKER_SKILLS=1`). Keep context files (AGENTS.md/CLAUDE.md of the project are wanted) and the extensions (worker-guard and model routing need them). Verify with one live worker that `read`/`bash`/the guard still load, and compare the first-request token count before/after.

**A5. Filter test and typecheck output before it reaches the model** (Impact: High, T+R)
- Gap: QA and builders run suites and pyright directly; output lands in context (one suite took ~3 min; 17 suites per QA pass; pyright's 29 pre-existing errors printed every run). Guard friction also comes from per-suite loops/variable paths. Anthropic MCP/code-execution: filter and aggregate in the execution environment, return only the result; pi docs: "tools MUST truncate" (`truncateTail` for logs).
- Target files: new `scripts/run-suites.mjs`, `references/worker-common.md` (point to it), `agents/qa.md`, `agents/qa-bugfix.md`, `agents/plan-step-builder.md`, `package.json` (`files`), `lib/readme-test.ts`.
- Task: `node scripts/run-suites.mjs --python <abs path> --cwd <dir> <suite...>` runs each suite, writes the full output to `.foreman/qa-logs/<suite>.log`, prints one line per suite (`PASS name 12.3s` / `FAIL name`), the failing test names and the last 30 lines of each failure, and exits non-zero on any failure. Same for `--pyright` with a baseline file (reuse `scripts/baseline-diff.mjs`). One literal command, so it is guard-friendly. Note the guard cannot see inside the script (documented limit in `references/worker-guard.md`); the script only executes the named suite paths.

**A6. Split the `foreman` skill by branch (progressive disclosure)** (Impact: Medium-High, T+M)
- Gap: `skills/foreman/SKILL.md` is 424 lines / ~6.4k tokens, over the Agent Skills recommendation (< 500 lines and < 5,000 tokens), and `extensions/foreman-mode/prompts.ts` injects all of it, including branches most runs never take (§1.5 audit, §0.5 optional dependencies, §6 guardrail troubleshooting). writing-for-agents: disclose what only some branches reach behind a pointer, one trigger per branch; agentskills best practices: "tell the agent when to load each file".
- Target files: `skills/foreman/SKILL.md`, new `references/foreman-audit.md` and `references/foreman-delegation.md` (the long §4 tables), `references/guardrail-troubleshooting.md` (already exists: §6 should only point to it), `extensions/foreman-mode/prompts.ts`, `extensions/foreman-mode/smoke-test.ts`.
- Task: keep in SKILL.md only §0 (workspace/mode), §1 (orient), §2 (grill), §3.5 (rulings), the delegate loop and §5 (never do). Replace each moved section with one pointer line stating the condition ("If the request is an audit, read `references/foreman-audit.md`"). Target ≤ 3.5k tokens. `buildAuditPrompt` loads the audit reference directly.
- Acceptance: a replay of two grilling sessions and one audit shows the same behaviour; `prompts.ts` tests pass.

**A7. Make `/foreman` and `/plan-runner` user-invoked skills** (Impact: Low, T)
- Gap: `foreman` and `plan-runner` keep model-facing descriptions (~250 tokens in every orchestrator and worker prompt), but both are entered by commands that embed the body (`prompts.ts`), and `session-reminder` already tells the model about the commands. SKILL-MECHANICS: a skill that only fires by hand should be user-invoked (`disable-model-invocation: true`) and cost no context.
- Target files: `skills/foreman/SKILL.md`, `skills/plan-runner/SKILL.md` frontmatter; keep `design-preview` and `project-memory` model-invoked (the foreman skill must reach them). Risk: `pi-claude-cli` resolves skills itself (see `~/CLAUDE.md` gotchas); verify with the load check before shipping.

**A8. Report size and read discipline** (Impact: Low, T)
- Gap: the orchestrator `read` worker reports in full (19 reads, ~26.7k tokens) because the notification carries only a 400-char summary and no size hint. Anthropic: metadata (file sizes) lets agents decide what to open.
- Target files: `extensions/coordination/coordinator.ts` (`formatNotification`), `skills/plan-runner/SKILL.md`, `skills/foreman/SKILL.md`.
- Task: add `report: <N> lines` to each notification and a rule "read the report only when status is not completed or the summary leaves a question; read with `limit`".

**A9. Planner: edit the plan instead of rewriting it** (Impact: Medium, T)
- Gap (measured, corrected): the two planner runs cost ~86k output tokens (an earlier figure of 173k double-counted: the old event logs hold each message twice, once as `message_update`/`turn_end` and once as `message_end`). The cause is that `agents/planner.md` lists `tools: read, grep, find, bash, write`, with no `edit`. Pass 1 wrote the 52KB plan; pass 2 only had to apply six user decisions but had to re-emit the entire 71KB (~18k tokens) file, one tool call of ~33k output tokens that ran for minutes with nothing visible. Cost is output tokens (the expensive kind) plus the wait.
- Target files: `agents/planner.md`, `extensions/worker-guard/policy.ts` (`plannerMayWrite` already scopes planner writes to `docs/plans/`; extend it to the `edit` tool), `extensions/worker-guard/smoke-test.ts`, `templates/handoff-prompt.md` (revision handoffs say "apply these decisions with edits").
- Task: add `edit` to the planner tools, restricted by the guard to `docs/plans/<name>.md`; revision handoffs list decisions and the planner edits only the affected steps. Also have the planner write the plan in two stages for large plans (outline, then step bodies) so no single call exceeds ~8k output tokens. Acceptance: a replay of the readme-gap revision costs < 10k output tokens.

#### B. Skill and prompt structure

**B1. Rewrite worker-facing text for agents, not humans** (Impact: Medium, R+M)
- Gap: `references/worker-common.md` (~1.3k tokens, appended to every worker), `templates/*.md` and `agents/*.md` mix rules with history ("A live test caught a subagent stalling…"), steer by prohibition (`Never git stash…`, `don't retry or work around it`), and repeat the same guard rules in `worker-common.md`, `references/worker-guard.md` and hand-typed handoffs. writing-for-agents: positive target first, a negation only as a hard guardrail paired with the positive alternative; prune no-ops and sediment; leading words; agentskills: a Gotchas section of concrete corrections is the highest-value content.
- Target files: `references/worker-common.md`, `references/worker-guard.md`, `templates/*.md`, `agents/*.md`.
- Task: (1) move history to `docs/verification-log.md`; (2) add a `## Gotchas` section built from this session: command name must be a literal path, one command per suite, `.foreman/` is the scratch area, `python3 -c` probes limited to imports/prints, a denied probe goes under `Guard-denied`; (3) state each rule once (worker-common) and make the others point to it; (4) restate prohibitions positively ("compare against a baseline with `git show <sha>:<path>`"). Acceptance: `worker-common.md` ≤ 900 tokens; `lib/readme-test.ts`/`agents-test.ts` pass.

**B2. Plan template: add Testing decisions and Out of scope; keep file paths** (Impact: Low-Medium, M)
- Gap: Matt Pocock's `to-spec` template carries "Testing Decisions" (seams, what makes a good test, prior art) and "Out of Scope", and tells the author not to put file paths in a spec because they go stale. `agents/planner.md` has a "Testing strategy" section but no seam guidance and no Out-of-scope heading; our plans must keep `Touches` paths because plan-runner uses them to decide parallel safety. This is an intentional divergence, not a gap.
- Target files: `agents/planner.md`, `lib/plan-steps.ts` (only if the parser needs the new headings), `lib/plan-steps-test.ts`.
- Task: add "Seams (prefer existing, highest possible, ideally one)" and "Out of scope" to the planner contract; leave `Touches`/`Checks`/`Renders` as they are.

**B3. Grilling: reuse, do not duplicate** (Impact: Low, M)
- Gap: `skills/foreman/SKILL.md` §2 carries its own fallback interview and an install nudge for `grill-me`; Matt's `grill-me` is a one-line user-invoked skill that calls the shared `grilling` skill (the router/shared-reference pattern in SKILL-MECHANICS). 
- Target files: `skills/foreman/SKILL.md` §2, `references/optional-dependencies.md`.
- Task: reduce §2 to "invoke `grilling` (or `grill-me`); if neither is installed, read `references/grilling-fallback.md`". Saves ~150 tokens per run and removes a drifting copy.

**B4. Add an eval loop for the skills themselves** (Impact: Medium, M+R)
- Gap: the repo has solid tests for code (guard, coordinator) but none for prompt behaviour; the agentskills guide says to read execution traces and refine with real runs, and Anthropic says to tune compaction prompts on real traces. Today the knowledge sits in one-off handoff files and `/foreman-diagnose`.
- Target files: `scripts/trace-report.mjs` (new), `extensions/coordination/coordinator.ts` (write usage into `<task>.json`), `references/diagnosing-a-run.md`, `docs/verification-log.md`.
- Task: persist per-worker `usage` (input/output/cache tokens, turns, tool calls, guard denials by reason) in the run json; `trace-report.mjs <run-dir>` prints the table used in this audit. Add 3 replay fixtures (the readme-gap steps 0, 6 and 15 handoffs) to compare token cost and block count before/after each change in this plan.

#### C. Missing guardrails and failure modes

**C1. Circuit breaker for repeated identical failures** (Impact: High, R)
- Gap: step 0 was dispatched six times with the same "guard refused X" outcome, and the orchestrator only changed the wording of the handoff. Nothing in the coordinator counts attempts. This is the runaway-loop failure mode.
- Target files: `extensions/coordination/coordinator.ts`, `extensions/coordination/index.ts` (tool result text), `skills/plan-runner/SKILL.md` §3.5, `extensions/coordination/smoke-test.ts`.
- Task: count dispatches per `(planSlug, planStep)` and remember the last `Blocked-on`/error. From the 3rd dispatch of a step whose last two outcomes were `blocked`/`failed`, the `foreman_delegate` result says "attempt N; previous attempts ended: <reasons>. Rule on it (skip, degrade, change approach) or ask the user before dispatching again." Baseline-type steps degrade after one failure (see D2).

**C2. Mid-task retry for transient provider errors, with shared back-off** (Impact: High, R)
- Gap: `lib/retry.ts` only retries a worker that produced no output, so every 429/503 that hit a working builder (steps 10, 12, 14, 17, plus the 503 "credential validation failed") surfaced as `failed` and needed a manual resume dispatch. Back-off is per worker, no jitter, 3 retries at 30/60/120 s, and parallel workers hit the limit together.
- Target files: `lib/retry.ts`, `lib/retry-test.ts`, `extensions/coordination/spawn-worker.ts`, `extensions/coordination/coordinator.ts` (shared gate), `lib/spawn.ts`.
- Task: (1) add 503 "credential validation" to `TRANSIENT_RE`; (2) on a transient failure after output, re-spawn with a generated resume preamble ("run `git status` and `git log -3`, continue from what exists, commit only your paths") and a cap of 2; (3) a coordinator-level gate: after a 429, pause new spawns for the back-off (jittered, honour `retry-after` when present) and halve effective concurrency, restoring one slot per clean finish; (4) default `FOREMAN_MAX_WORKERS` for writer roles 2 (override via env).

**C3. Orphaned workers leave evidence** (Impact: Medium, R)
- Gap: `recover()` reports `orphaned (orchestrator restarted)` with no detail and the run md does not exist, so the orchestrator hit ENOENT and had to guess whether partial work existed.
- Target files: `extensions/coordination/coordinator.ts` (`recover`, `delegate`), `extensions/coordination/spawn-worker.ts`.
- Task: write a stub `<task>.md` at spawn time; in `recover()` add the last assistant text from `<task>.events.jsonl` and `git status --short` of the worker cwd to the notification; make task ids unique per session (`t1` repeated across 5 run ids).

**C4. Worktree-aware workdir and working isolation** (Impact: High, R)
- Gap: workers start in the main checkout while the plan runs in `.worktrees/readme-gap`. Auto-isolation then branched from the main checkout's HEAD (`master`), rewrote the handoff path to a non-existent `<iso>/.worktrees/readme-gap`, and lacked `.venv`; workers kept editing the shared plan worktree, so two writers collided (step 10 vs 16 i18n key counts). `.foreman/` writes for `qa`/`shipper` were refused because the guard root was the main checkout.
- Target files: `lib/worktree.ts`, `lib/worktree-test.ts`, `extensions/coordination/spawn-worker.ts`, `extensions/coordination/index.ts` (new `workdir` param, set by plan-runner step 0), `extensions/worker-guard/policy.ts`, `skills/plan-runner/SKILL.md`, `references/using-worktrees.md`.
- Task: `foreman_delegate` takes/remembers `workdir`; workers spawn with `cwd = workdir` and the guard root follows; isolation branches from `workdir` HEAD, merges back into it, symlinks untracked environment dirs (`.venv`, `node_modules`) and only rewrites paths under the workdir; plan-steps lint flags overlapping `Touches` inside one `## Parallel` wave and plan-runner runs those serially.

**C5. Guard false positives that stopped real work** (Impact: High, R)
- Gap (verified by running the current `policy.ts`): `mkdir .foreman` itself is denied for `qa`/`shipper` (`segs.length > 1` check); writes to `<linked worktree>/.foreman/…` are denied for scoped roles when cwd is the main checkout; `P=…; for s in …; do $P … >/tmp/o_$s.txt; done` is denied (assignment plus loop do not compose in `vars.ts`); `../x` redirects are denied for scoped roles; `python3 -c "…len(json.load(open(f)))"` is denied for planner/reviewer. A denial also forces `Status: blocked`, so a refused probe turned an otherwise complete review into `blocked`.
- Target files: `extensions/worker-guard/policy.ts`, `extensions/worker-guard/vars.ts`, `extensions/worker-guard/smoke-test.ts`, `references/worker-common.md` (including the report contract: new `Guard-denied:` field), `references/worker-guard.md`.
- Task: allow the `.foreman` directory itself and `<linked worktree>/.foreman/**` for scoped roles; compose `expandForLoop` with literal-variable resolution; resolve relative redirects and judge the result; widen the `python3 -c` probe to pure expressions over `json.load(open(...))`, `len`, `print`; replace the denial suffix with "continue the remaining work, list the denied command under `Guard-denied:`" and keep `blocked` for denials that prevent the core deliverable (coordinator marks `completed` with a note otherwise). Add each case from the directAds run as a regression test.

**C6. Check promises before making them** (Impact: Medium, R)
- Gap: the plan promised `Renders: yes` screenshots but Playwright was missing, so six UI steps shipped "unrendered"; the reviewer cannot run tests and trusted QA's report; two worker "all green" claims were wrong and were caught only by a later QA pass.
- Target files: `agents/planner.md` (pre-flight list), `skills/plan-runner/SKILL.md` (step 0), `extensions/coordination/coordinator.ts` (post-step check), `agents/reviewer.md`.
- Task: plan-runner step 0 probes the render tool and test runner once and tells the user up front; after a builder reports `completed` the coordinator runs the step's declared `Checks:` itself (via `scripts/run-suites.mjs`) and annotates the notification `verified: yes|no|n/a`; reviewer asks for a `qa` pass on any range changed after the last QA.

#### D. Orchestrator behaviour (skills)

**D1.** Plan Status section created by plan-runner on first run; `Status` is the source of truth the notifications point at (Impact: Medium, M). Files: `skills/plan-runner/SKILL.md`, `lib/plan-steps.ts`.
**D2.** Baseline steps: one attempt, then record "baseline unavailable" and continue (Impact: Medium, T). Files: `skills/plan-runner/SKILL.md`, `agents/plan-step-builder.md`.
**D3.** `/foreman resume` command reads ledger, plan Status, orphan notes and re-dispatches instead of the user typing "resume" (Impact: Medium, R). Files: `extensions/foreman-mode/index.ts`, `extensions/foreman-mode/prompts.ts`, `lib/mode.ts`.
**D4.** Session reminder once per session; drop the pre-gathered `git status` block on `resume` (it is stale by definition) (Impact: Low, T). File: `extensions/session-reminder/index.ts`.

#### E. Worker activity visibility (can I tell working from stuck?)

**E1. Live activity line per worker, with stuck detection** (Impact: High, R)
- Gap: the widget (0.3.4) shows `▶ step 13 · Carousel UI · 4m43s`: it proves the process is alive, not that the worker is doing anything. `runPiJson` already receives every event of the worker's JSON stream but keeps only `message_end` and drops `message_update`, `tool_execution_start/update/end` and the `usage` they carry, so nothing about the current action reaches the UI. Real cases from the directAds run where this mattered: the planner's single 33k-token write call (minutes of silence), a QA suite that ran ~3 minutes, a worker that sat in the same blocked loop. Anthropic ctx: lightweight identifiers/metadata give agents (and humans) a signal about what is happening without loading the data; agentskills: read traces, not just final outputs.
- Target files: new `lib/activity.ts` (pure tracker) + `lib/activity-test.ts`; `lib/spawn.ts` (`RunPiJsonOptions.onEvent`, called for every parsed event before the `message_end` filter); `extensions/coordination/spawn-worker.ts` (wire it); `extensions/coordination/coordinator.ts` (Task.activity, `snapshot()`); `lib/workers.ts` (`renderWorkersUi`, `renderReport`); `lib/i18n/en.ts` and `pt-BR` catalogs; `scripts/herdr-tail.mjs` (optional); `extensions/coordination/smoke-test.ts`.
- Task:
  1. `ActivityTracker.feed(event, now)` keeps: `phase` (`starting | thinking | writing | tool | waiting`), `label`, `lastEventAt`, `lastProgressAt`, turns, tool-call count, live output tokens and cost (from `usage` in `message_update`), and a ring of the last 5 actions.
  2. Phase rules from the event types seen in real logs: `thinking_start/delta` → thinking, label = last ~70 chars of the thinking text when present (`thinking_delta` carries text; may be empty or redacted with some providers, then show the phase only); `toolcall_start/delta` → writing, label = `<tool> <path or command head>` with bytes streamed so far (partial `arguments` length), so a 140KB write shows `writing docs/plans/x.md · 48 KB`; `tool_execution_start` → tool, label = command head (60 chars) and file path, elapsed since start; `text_delta` → `reporting`; no event since `turn_end` → waiting for the provider.
  3. Health, shown as a glyph: `●` active (event in the last 20s), `◐` waiting (20-90s, or a tool running past its normal time), `⚠` silent (> 90s with no tool running, configurable `FOREMAN_STUCK_AFTER_S`), `⟳` repeating (same tool and same target 3 times in a row, or the same failing command), `✖` hit a guard denial (shows the first words of the reason).
  4. Widget line: `● step 13 · Carousel UI · 4m43s · writing app/static/js/builder.js 38 KB · 21 tools · 14k out`. `/foreman-status` expands each worker: last 5 actions with timings, the last thinking snippet, tokens and cost so far, the guard denials count.
  5. Notify once (UI + herdr) when a worker flips to `⚠` or `⟳`, and clear it when it recovers. No kill: the existing 30 min timeout stays; the notification names the worker and its last action so you can decide.
  6. Write the tracker state to `.foreman/runs/<run>/<task>.status.json` (atomic, at most every 2s). This lets the herdr pane and a later session read it, and it is the evidence C3 needs when an orchestrator restart orphans a worker (last action, tokens, last event time).
  7. Token neutral: the activity is UI/disk only and is never sent to the orchestrator's context (the orchestrator still gets only the final notification). The event log keeps filtering `message_update` so it does not grow.
- Acceptance: a unit test feeds a recorded stream (take the first 200 lines of a real worker log, with `message_update`) and asserts the labels and phase transitions; a fake silent stream flips to `⚠` after the threshold; a stream with three identical `bash` calls flips to `⟳`; the widget stays one line per worker at 100 columns (truncate the label, never the elapsed time).
- Not verified: that every provider streams `thinking_delta` text (the directAds orchestrator transcript shows empty thinking blocks while worker logs contain thinking text), so the thinking snippet is best effort and the phase is the reliable signal.

### Suggested order

1. **Phase A (mechanical, high leverage, one worker at a time):** C5 (guard), C4 (workdir), C2+C3 (retry/orphans), A4 (`--no-skills`), E1 (activity visibility; do it early so the later phases can be watched), A9 (planner `edit`).
2. **Phase B (token cuts, measurable with B4 fixtures):** B4 fixtures first, then A1, A2, A5, A3.
3. **Phase C (prompt/skill rewrites, verify by replay):** A6, B1, B3, A7, A8, D1-D4, C1, C6, B2.

### Fontes (audit)

- Anthropic, "Effective context engineering for AI agents": https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (context rot, smallest high-signal token set, tool-result clearing, just-in-time context, compaction, note-taking, sub-agents).
- Anthropic, "Code execution with MCP": https://www.anthropic.com/engineering/code-execution-with-mcp (tool definitions and intermediate results as the two token sinks; filter in the execution environment).
- Agent Skills specification and "Best practices for skill creators": https://agentskills.io/specification, https://agentskills.io/skill-creation/best-practices (progressive disclosure: ~100-token metadata, < 5,000-token body, < 500 lines; gotchas; defaults not menus; validation loops; refine from traces).
- Matt Pocock: AI Coding Dictionary https://www.aihero.dev/ai-coding-dictionary (smart/dumb zone, compaction, handoff artifact, progressive disclosure, subagent); `mattpocock/skills` (`writing-for-agents`, `grill-me`/`grilling`, `to-spec`), read from the installed copies in `~/.agents/skills/`.
- pi docs shipped with 1.5.2: `docs/skills.md`, `docs/compaction.md`, `docs/extensions.md` (`context`, `session_before_compact`, output truncation), `docs/cli.md`, `docs/codemode.md`, `docs/mcp.md`.
- Anthropic `anthropics/skills` repo (index and README only: skills are a directory with `SKILL.md` plus `scripts/`, `references/`, `templates/`). Not read in depth.

Not verified: the `earendil-works/pi` monorepo docs on GitHub (read the installed copies instead), whether `ctx.getContextUsage()` can drive an automatic compaction nudge (documented, not tried), and the behaviour of `--no-skills` together with the `pi-claude-cli` provider.

## Fontes

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md
- https://github.com/earendil-works/pi (README do monorepo)
- Repositório original do foreman: https://github.com/MTBasso/foreman
