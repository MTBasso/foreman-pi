# Hybrid Agent Workflow

## Active Model
- **Target Model:** `foreman/hybrid`

## Guardrail Architecture
- The local extension will intercept safety and policy refusals from Claude in real-time.
- If Claude triggers a refusal, a transition to `refuseless/deepseek-v4-abliterated` will be cleanly executed by the extension's `agent_settled` layer, preserving the full workspace history and conversation context.
