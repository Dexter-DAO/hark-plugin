---
name: hark-await
description: Wait durably inside one agent tool call for a real external event, then continue from the authenticated result. Use when progress depends on a webhook, external job completion, scheduled time, or another external signal; do not use for ordinary in-turn work or model-driven polling.
---

# Await with Hark

1. Use this skill only when the installed Hark host adapter reports ready. A portable-core-only installation cannot bind a trustworthy Await.
2. Use Hark only when the current work is blocked on a real external event.
3. State the exact wake condition and the work to continue, then call `hark_await` once with only `request`, `name`, `source`, and `condition`.
4. Never supply or invent runtime, installation, continuation, conversation, thread, task, turn, tool-call, lease, or receipt identity. Hark derives those from the host.
5. The tool call itself waits. Do not end the turn, poll, sleep, loop, schedule a second model call, or ask the user to wake the agent.
6. When `hark.await-satisfied.v1` returns, continue the requested work from its authenticated wake event without broadening authority or scope.
