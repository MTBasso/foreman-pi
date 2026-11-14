/**
 * Standalone smoke test, same spirit as the other extensions' smoke-test.ts:
 * exercises the real route()/agent_end/agent_settled logic against a faked
 * ExtensionAPI/ExtensionContext (incl. a fake modelRegistry), not a live pi
 * session or a live model call. Run with:
 *   npx tsx extensions/model-fallback/smoke-test.ts
 */
import extension from './index.ts';

type Handler = (event: any, ctx: any) => Promise<any> | any;

function assistantMsg(provider: string, text: string) {
  return { role: 'assistant', provider, content: [{ type: 'text', text }] };
}
function userMsg(text: string) {
  return { role: 'user', content: text };
}

function makeFakeApi(opts: { fallbackConfigured: boolean }) {
  const handlers: Record<string, Handler[]> = {};
  const sent: Array<{ message: any; options?: any }> = [];
  let registeredRoute: ((req: any, ctx: any) => any) | undefined;
  const commands: Record<string, any> = {};

  const catalog: Record<
    string,
    Record<string, { api: string; provider: string; id: string }>
  > = {
    anthropic: {
      'claude-sonnet-5-5': {
        api: 'anthropic',
        provider: 'anthropic',
        id: 'claude-sonnet-5-5',
      },
    },
    refuseless: {
      'deepseek-v4.1-flash-abliterated': {
        api: 'openai-completions',
        provider: 'refuseless',
        id: 'deepseek-v4.1-flash-abliterated',
      },
    },
  };

  const modelRegistry = {
    find: (provider: string, id: string) => catalog[provider]?.[id],
    hasConfiguredAuth: (model: any) =>
      model?.provider === 'refuseless' ? opts.fallbackConfigured : true,
  };

  const api = {
    on(event: string, handler: Handler) {
      (handlers[event] ??= []).push(handler);
      return () => {};
    },
    registerCommand(name: string, options: any) {
      commands[name] = options;
    },
    registerVirtualModel(def: any) {
      registeredRoute = def.route;
    },
    sendMessage(message: any, options?: any) {
      sent.push({ message, options });
    },
  };

  return {
    api,
    handlers,
    sent,
    commands,
    modelRegistry,
    route: (req: any) => registeredRoute!(req, { modelRegistry }),
  };
}

async function fire(
  handlers: Record<string, Handler[]>,
  event: string,
  payload: any,
  ctx: any
) {
  for (const h of handlers[event] ?? []) await h(payload, ctx);
}

async function main() {
  let failures = 0;
  const check = (label: string, cond: boolean) => {
    console.log(`${cond ? 'ok ' : 'FAIL'} - ${label}`);
    if (!cond) failures++;
  };

  // --- Scenario 1: normal reply, no refusal -> stays on primary, no retry triggered.
  {
    const { api, handlers, sent, modelRegistry, commands } = makeFakeApi({
      fallbackConfigured: true,
    });
    await extension(api as any);
    check(
      'refuseless command is registered',
      typeof commands['refuseless']?.handler === 'function'
    );
    const messages = [userMsg("what's 2+2?"), assistantMsg('anthropic', '4.')];

    await fire(handlers, 'agent_end', { messages }, { modelRegistry });
    await fire(
      handlers,
      'agent_settled',
      { aborted: false },
      { modelRegistry }
    );
    check('no refusal -> no retry message sent', sent.length === 0);
  }

  // --- Scenario 2: refusal from primary, fallback configured -> retry triggered, route picks GPT.
  {
    const { api, handlers, sent, modelRegistry, route } = makeFakeApi({
      fallbackConfigured: true,
    });
    await extension(api as any);
    const refusalText = "I can't help with that request.";
    const messages = [
      userMsg('do the thing'),
      assistantMsg('anthropic', refusalText),
    ];

    await fire(handlers, 'agent_end', { messages }, { modelRegistry });
    await fire(
      handlers,
      'agent_settled',
      { aborted: false },
      { modelRegistry }
    );
    check(
      'refusal + fallback configured -> retry message sent',
      sent.length === 1
    );
    check(
      'retry message triggers a turn',
      sent[0]?.options?.triggerTurn === true
    );

    const routed = route({
      messages,
      thinkingLevel: 'off',
      reason: 'continuation',
    });
    check(
      'route() picks the fallback model after a primary refusal',
      routed.model?.provider === 'refuseless'
    );
  }

  // --- Scenario 3: refusal from primary, no fallback credential -> no retry, warned instead.
  {
    const { api, handlers, sent, modelRegistry } = makeFakeApi({
      fallbackConfigured: false,
    });
    await extension(api as any);
    const messages = [
      userMsg('do the thing'),
      assistantMsg('anthropic', "I can't help with that."),
    ];

    await fire(handlers, 'agent_end', { messages }, { modelRegistry });
    await fire(
      handlers,
      'agent_settled',
      { aborted: false },
      { modelRegistry }
    );
    check(
      'no fallback credential -> warning sent, not a retry',
      sent.length === 1
    );
    check('warning does not trigger a turn', !sent[0]?.options?.triggerTurn);
  }

  // --- Scenario 4: after fallback already answered (even with refusal-shaped text),
  //     route() must NOT escalate further -- last assistant is no longer "anthropic".
  {
    const fake2 = makeFakeApi({ fallbackConfigured: true });
    await extension(fake2.api as any);
    const messages = [
      userMsg('do the thing'),
      assistantMsg('anthropic', "I can't help with that."),
      assistantMsg('refuseless', "I can't help with that either."),
    ];
    const routed = fake2.route({
      messages,
      thinkingLevel: 'off',
      reason: 'continuation',
    });
    check(
      'no further escalation once fallback has already answered',
      routed.model?.provider === 'anthropic'
    );
  }

  // --- Scenario 5: long reply containing "I can't" mid-paragraph is not misdetected.
  {
    const fake = makeFakeApi({ fallbackConfigured: true });
    await extension(fake.api as any);
    const longReply =
      "Here's how to implement that: ".repeat(10) +
      "Note that I can't guarantee the exact performance, but this approach should work well. " +
      "Here's the full code and explanation of every step involved in this implementation.";
    const messages = [
      userMsg('implement X'),
      assistantMsg('anthropic', longReply),
    ];
    await fire(
      fake.handlers,
      'agent_end',
      { messages },
      { modelRegistry: fake.modelRegistry }
    );
    await fire(
      fake.handlers,
      'agent_settled',
      { aborted: false },
      { modelRegistry: fake.modelRegistry }
    );
    check(
      "long non-refusal reply with 'I can't' mid-text is not misdetected",
      fake.sent.length === 0
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main();
