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

## Fontes

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md
- https://github.com/earendil-works/pi (README do monorepo)
- Repositório original do foreman: https://github.com/MTBasso/foreman
