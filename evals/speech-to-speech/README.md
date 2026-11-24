# Speech-to-speech eval

How well a Curb agent works when a speech-to-speech model (`<Agent s2s>`) answers its calls. Four
small agents with fake data, 44 caller cases, each played two ways and scored the same way:

- **text**: the case in text, with `curb/testing` (`startCall` and `converse`). On an agent with
  `s2s`, each caller line goes to the agent's back office, so this measures what `llm` does with
  the words, without the speech model. It is the baseline.
- **voice**: the case as a real call. `curb server` serves the agent, a local call carries the
  caller's voice (KugelAudio TTS) to the speech model in real time, the model talks and hands work
  to Curb, and the call is read back from the server's conversation store with `loadCalls`.

What differs between the two is what the speech model adds: what it hears, when it hands over,
and what it says on its own.

## What is scored

Per conversation, from its turns (`harness/score.ts`):

| Capability | Scored as |
|---|---|
| Finds the right skill | The first skill the agent reads is the one the caller's request needs |
| Navigates between skills | In cases that move between skills: every skill the call needs is reached, and no skill it does not need is read |
| Calls the right tools | Every expected tool ran with the expected arguments, no other business tool was called, and no forbidden tool ran. Precision and recall over tool names, and the share of expected tools never called with the right arguments |
| Turns and latency | Caller turns per call. Text: the duration of each turn. Voice: from the end of the caller's speech to the agent's first audible audio, and to the answer after Curb's turn |
| Heard (voice) | Word error rate of the model's transcript of each caller line |

Every conversation is also saved as a Curb test run (`.curb/test-runs/` of the agent), so
`npx curb review .curb/test-runs` and `npx curb test --rejudge` read them like any other.

## The agents

| Agent | Language | Skills | Tools |
|---|---|---|---|
| `clinic` | German | book, cancel, practice info | `freie_termine_suchen`, `termin_buchen`, `termin_finden`, `termin_absagen`, `rueckruf_anfordern` |
| `shop` | English | order status, returns, shipping info | `look_up_order`, `send_tracking_link`, `check_return_eligibility`, `start_return`, `request_human` |
| `bank` | German | identity check, then address change or card block; branch info | `identitaet_pruefen`, `adresse_aendern` (confirm), `karte_sperren` (confirm), `rueckruf_anfordern` |
| `energy` | English | meter reading, tariffs, moving house (`<Procedure>`) | `submit_meter_reading`, `estimate_monthly_cost`, `register_move`, `request_callback` |

Each agent's cases are in `agents/<agent>/src/agent/eval.scenario.ts`: scripted and simulated
callers, direct requests, ambiguous ones, topic switches, a question in the middle of a flow and
back, interruptions (voice only: the line starts while the agent speaks), callers who refuse a
step, FAQ questions and escalation. `evalCase()` (`harness/spec.ts`) makes each an ordinary Curb
scenario, so `npx curb test` in an agent's folder runs them too.

## Run it

`npm install` at the repository root, then put the keys in the environment or in each agent's
`.env` (`agents/*/.env.example`):

```bash
export KUGELAUDIO_API_KEY=...   # the agents' llm, and the caller's voice
export S2S_BASE_URL=https://api.example.com/v1 S2S_MODEL=... S2S_API_KEY=...   # the model under test
export OPENAI_API_KEY=...       # only with --caller-model openai:...

node run.mjs text --runs 3 -- --caller-model openai:gpt-5.4-mini
node run.mjs voice --runs 1 -- --caller-model openai:gpt-5.4-mini
npx tsx harness/summarize.ts .results/<run>
```

`node run.mjs both` runs one after the other. One agent alone:

```bash
cd agents/clinic
npx curb run ../../harness/text.ts --runs 3 --filter ambiguous
npx curb run ../../harness/voice.ts --filter "sagt einen"
```

`--filter` takes part of a case's name or a kind (`direct`, `ambiguous`, `topic_switch`, `back`,
`multi_step`, `interruption`, `refusal`, `faq`, `escalation`). Results go to `.results/` (ignored
by git): `<agent>.<path>.json` per agent and path, the logs, and `summary.md`.

Without `S2S_BASE_URL` the agents have no `s2s` and run cascaded; the text path then measures
the agent on `llm` alone, and the voice path needs `stt` and `tts` instead.

## Costs

The text path costs LLM tokens like `curb test`. The voice path is a real call: speech-model
minutes, TTS for the caller's lines, and the LLM behind the model. A voice case takes one to two
minutes, and an agent's calls run one after another.
