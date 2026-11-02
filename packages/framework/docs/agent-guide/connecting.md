# Connecting to a running agent

Your agent is running. This page says how your app, your backend and other services talk to it,
on KugelAudio and on your own servers, and where the detail is.

Only three kinds of connection exist. The caller reaches the agent through a call, the host talks
to the runner, and the agent calls out to your systems. Your backend is on none of them directly:
it goes through the host, or waits for the agent to call it.

```text
  Caller's phone ─────── phone line ───────┐
                                           ▼
  Caller's app ───────── LiveKit room ──▶ Runner: your agent ──▶ Your APIs and MCP servers
                                           ▲                     (tools call out over HTTP)
                                           │ host protocol v1: only the host reaches it
                                           │
                                        The host: KugelAudio, or your own
                                           ▲
                                           │ KugelAudio's API, or your own
                                           │
                                        Your backend
```

| Who | On KugelAudio | On your own servers |
|---|---|---|
| A web page | [Web widget](https://docs.kugelaudio.com/hosted-agents/web-widget) | [`curb/client`](./client.md) in a LiveKit room your server created |
| A mobile or desktop app | [Session API](https://docs.kugelaudio.com/hosted-agents/native-apps) and a LiveKit SDK | A LiveKit SDK in a room your server created |
| A phone | [Phone numbers](https://docs.kugelaudio.com/hosted-agents/phone-numbers) | LiveKit SIP ([Self-hosting](./hosting.md)) |
| Your backend, starting a call | [Outbound calls API](https://docs.kugelaudio.com/hosted-agents/outbound-calls) | Your host, with `POST /v1/sessions` |
| Your backend, during a call | No published route: the agent calls your API | Your host, over the [host protocol](./host-protocol.md) |
| Your backend, after a call | [After-call code](./after-call-code.md) that sends to it | [Hook runner](./hosting.md#hook-runner), or the event stream |

Hosting on KugelAudio is in closed alpha, and hosted deploys do not accept a project that installs
Curb from npm yet ([Deploying](./deploying.md)).

## The caller's app

The app starts the call and passes what it knows, which the agent reads as `client.<key>`
([Knowing the caller](./knowing-the-caller.md)). Treat that as a hint, never as proof of who is
calling. [Calls from your website](./web-calls.md) covers the widget and its context.

During a call, an app in the LiveKit room exchanges [app messages](./app-messages.md) with the agent
and [changes settings](./mid-call-changes.md) with `curb/client`. It needs the room itself. The
session API gives your app that room. The web widget's published interface is `start()`, `end()` and
its context.

## A backend during a call

The direct way works on every host: the agent calls your API from a [tool](./tools.md) or an
[MCP server](./mcp.md), with its keys in its variables. A hosted agent reaches public addresses only,
over HTTPS on port 443 and HTTP on port 80.

For your backend to reach into a live call, it needs a host that passes the request on. On your own
servers, that is your host. On KugelAudio, there is no published route for this yet.

## The host

The host starts the runner, creates rooms and tokens, places calls and follows them. On KugelAudio,
the platform is the host. On your own servers, you write it. [Architecture](./architecture.md) says
who owns what.

These routes are the runner's own, on its management port:

| Route | What it does |
|---|---|
| `POST /v1/sessions` | Starts a call |
| `GET`, `DELETE /v1/sessions/{id}` | Reads and ends a call |
| `POST /v1/sessions/{id}/messages` | Sends an app message to a call |
| `PATCH /v1/sessions/{id}` | Changes a call's live settings |
| `GET /v1/runner/events` | Streams everything the runner reports |
| `POST /v1/hooks/{name}` | Runs `afterCall` or `afterEvaluation` |

Only whatever runs the runner reaches them. They take a bearer token kept per runner, which must not
reach a browser or an app, so they are not an API for your app or your backend. On your own servers,
put your own API in front of your host. [Host protocol](./host-protocol.md) has every route.

## What a KugelAudio-hosted agent uses instead

Nothing can connect into a hosted agent, and its runner's routes are not reachable. Use these:

| To | Use | Authorized by |
|---|---|---|
| Open a call from an app | [`POST /v1/agents/public/endpoints/{id}/sessions`](https://docs.kugelaudio.com/hosted-agents/native-apps) | No key: the endpoint's listed websites, as `Origin` |
| End that call | [`POST /v1/agents/public/sessions/{id}/end`](https://docs.kugelaudio.com/hosted-agents/native-apps) | The call's join ticket |
| Place a phone call | [`POST /v1/agents/projects/{id}/outbound-calls`](https://docs.kugelaudio.com/hosted-agents/outbound-calls) | An API key, on your server |
| Follow or cancel it | [`/v1/agents/outbound-calls/{id}`](https://docs.kugelaudio.com/hosted-agents/outbound-calls#follow-the-call) | An API key, on your server |
| Keep data with a call | [`send.toHost`](./app-messages.md): it shows on the call's **Data** tab | Nothing to set |

The session API and the outbound calls API are on different addresses, so copy each from its page.

Sending a message into a live call and changing its settings have no published route for your
server. `askHost` gets no reply, so use `toHost`. A coding agent connected through the
[MCP server](https://docs.kugelaudio.com/guides/mcp-server) can read calls and end one.

## After a call

[After-call code](./after-call-code.md) runs `afterCall` and `afterEvaluation` from your project,
with the transcript and the call data, and is the place to update a CRM.

- On KugelAudio, a plan that includes it runs each hook with retries. There are no post-call
  webhooks yet, so a hook or a tool sends what your systems need, and the **Calls** page exports the
  rest.
- On your own servers, your host runs them on a [hook runner](./hosting.md#hook-runner). It can also
  read the [event stream](./host-protocol.md#event-stream), or keep calls in your own store with
  `KUGEL_CONVERSATION_SINK` ([Self-hosting](./hosting.md#what-self-hosting-includes)).

## Next steps

- [App messages](./app-messages.md): what the agent sends and handles.
- [Host protocol](./host-protocol.md): the runner's routes, for a host of your own.
