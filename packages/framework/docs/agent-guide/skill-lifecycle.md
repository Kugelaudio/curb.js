# Skill lifecycle

A skill joins the request when the model reads it, and it leaves when newer reads push it out.

A conversation has **one transcript**, and it is shared by every skill. At most
`maxLoadedSkills` skills (default 3) are loaded; reading one more unloads the least recently
used. The table says what happens to a skill's parts when it unloads:

| Part | When the skill unloads |
|---|---|
| Its instructions and text | Leave `<current_context>` |
| Its tools | Leave the request. A call of a tool that is not rendered, for this or any other reason, is refused with `Unknown tool`, and the model reads that |
| Its `useState` and refs | Gone: the component unmounts, and reading the skill again starts from its initial state |
| Its `createAgentStore` state | Stays, and is there when the skill is read again |
| Its tool calls and results in the transcript | **Stay**, including the `contextChanged` lines |
| What the caller and the agent said while it was active | **Stay** |

Every loaded skill's tools work, not only the active skill's. The active skill is the one read
last; reading a loaded skill again makes it active. No tool leaves a skill: a skill stays loaded
until newer reads push it out.

So tools and instructions unload with a skill, and history does not. A later skill can read
what an earlier skill's tools returned, and the first 200 characters of each line that skill
added to the context, until those messages leave the window.

### Context per skill

There is no context per skill: no skill has a transcript of its own, and no setting hides
history from a skill. What you can scope per skill is what the tree renders: instructions,
text, tools and providers.

If a value must not reach a later part of the conversation, keep it out of the transcript:
do not return it from a tool, and do not render it as text that a tool call adds. Hold it in
a store or in your own system, and let a tool act on it.

### How much history the model reads

`maxTranscriptMessages` (default 60) caps the transcript in each request. It counts messages,
not turns or characters: a tool call and its result are two messages, so a tool-heavy call
uses the window faster. The oldest messages leave first, whichever skill they came from, and
the window always starts at a user message, so no tool result loses its call. Nothing is
summarized.

The full transcript is still recorded; only the model's window is capped. `<current_context>`
is outside the cap, so what is rendered is always there.

## Next steps

- [State and conditional tools](./state.md): keep what must survive in a store.
- [What the model receives](./what-the-model-receives.md): the real requests.
