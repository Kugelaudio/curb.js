# Hooks

Hooks read the call and act on it, imported from `curb`. Use `useState` and `useEffect` from `react`,
as in any React project.

| Hook | What it gives you |
|---|---|
| [`useRouter`](./hooks/use-router.md) | Load a skill from code |
| [`useRoutePath`](./hooks/use-route-path.md) | The current skill's path |
| [`useAgentInfo`](./hooks/use-agent-info.md) | Everything the call knows |
| [`useClient`](./hooks/use-client.md) | What the caller's page said |
| [`useSession`](./hooks/use-session.md) | The active providers, and this call's identity |
| [`useVariant`](./hooks/use-variant.md) | This call's variant of an experiment |
| [`useSend`](./hooks/use-send.md) | Send a message to the page or the host |
| [`useMessage`](./hooks/use-message.md) | Handle a message from the page or the host |
| [`useTransferCall`](./hooks/use-transfer-call.md) | Put the caller through to a number |

A hook made by [`createAgentStore`](./functions/create-agent-store.md) holds state that lasts the
whole call.

## Next steps

- [Functions](./functions.md): `defineAgent`, stores and errors.
- [Components](./components.md): what an agent renders.
