// @ts-nocheck
/** A scripted server on the OpenAI Realtime protocol: no model, no key. `script` answers each
 * `response.create`; `callerSays` is what its transcription heard. */
import { WebSocketServer } from "ws";
export function startFakeRealtimeModel(): Promise<any> {
  const state = { wire: [], script: [], audioAppends: 0, appendBytes: [], url: null, cancelled: new Set() };
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let n = 0;
  const id = (p) => `${p}_${++n}`;
  wss.on("connection", (ws, req) => {
    state.url = req.url;
    state.authorization = req.headers.authorization;
    state.send = (o) => send(o);
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ event_id: id("evt"), ...o }));
    send({ type: "session.created", session: { id: id("sess"), object: "realtime.session", type: "realtime", model: "fake" } });
    ws.on("message", async (buf) => {
      const ev = JSON.parse(buf.toString());
      if (ev.type === "input_audio_buffer.append") {
        state.audioAppends++; state.appendBytes.push(Buffer.from(ev.audio, "base64").length); return;
      }
      state.wire.push(ev);
      if (ev.type === "session.update") send({ type: "session.updated", session: ev.session });
      if (ev.type === "conversation.item.create") {
        const item = { ...ev.item, id: ev.item.id ?? id("item") };
        send({ type: "conversation.item.added", previous_item_id: ev.previous_item_id ?? null, item });
        send({ type: "conversation.item.done", item });
      }
      if (ev.type === "conversation.item.delete") send({ type: "conversation.item.deleted", item_id: ev.item_id });
      if (ev.type === "conversation.item.truncate") send({ type: "conversation.item.truncated", item_id: ev.item_id, content_index: 0, audio_end_ms: ev.audio_end_ms });
      if (ev.type === "response.cancel") state.cancelled.add(state.current);
      if (ev.type === "response.create") {
        const step = state.script.shift() ?? { text: "ok." };
        const step2 = typeof step === "function" ? step(ev) : step;
        await respond(send, ev, step2, state, id);
      }
    });
  });
  return new Promise((res) =>
    wss.on("listening", () =>
      res({
        state,
        baseURL: `http://127.0.0.1:${wss.address().port}/v1`,
        /** The transcription of the caller's turn, then the model's reply if `respond` is set. */
        callerSays: async (text, { reply } = {}) => {
          const itemId = id("user");
          const item = { id: itemId, object: "realtime.item", type: "message", role: "user", status: "completed", content: [{ type: "input_audio", transcript: null }] };
          state.send({ type: "input_audio_buffer.speech_started", item_id: itemId, audio_start_ms: 0 });
          state.send({ type: "input_audio_buffer.speech_stopped", item_id: itemId, audio_end_ms: 500 });
          state.send({ type: "input_audio_buffer.committed", item_id: itemId, previous_item_id: null });
          state.send({ type: "conversation.item.added", previous_item_id: null, item });
          state.send({ type: "conversation.item.done", item });
          state.send({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, content_index: 0, transcript: text });
          if (reply) await respond(state.send, {}, reply, state, id);
        },
        /** The model acts with no new words from the caller. */
        toolCall: (reply) => respond(state.send, {}, reply, state, id),
        responses: () => state.wire.filter((event) => event.type === "response.create"),
        close: () => wss.close(),
      }),
    ),
  );
}
async function respond(send, ev, step, state, id) {
  const rid = id("resp"); state.current = rid;
  send({ type: "response.created", response: { id: rid, object: "realtime.response", status: "in_progress", metadata: ev.response?.metadata ?? null, output: [] } });
  const output = [];
  const cancelled = () => state.cancelled.has(rid);
  if (step.text) {
    const itemId = id("msg");
    const item = { id: itemId, object: "realtime.item", type: "message", role: "assistant", status: "in_progress", content: [] };
    send({ type: "response.output_item.added", response_id: rid, output_index: 0, item });
    send({ type: "conversation.item.added", item });
    send({ type: "response.content_part.added", response_id: rid, item_id: itemId, output_index: 0, content_index: 0, part: { type: "audio", transcript: "" } });
    const words = step.text.split(" ");
    const msPerWord = step.msPerWord ?? 20;
    for (const w of words) {
      if (cancelled()) break;
      send({ type: "response.output_audio_transcript.delta", response_id: rid, item_id: itemId, output_index: 0, content_index: 0, delta: w + " " });
      // 24 kHz PCM16 mono: msPerWord of low tone
      const samples = new Int16Array(24 * (step.audioMsPerWord ?? 200));
      for (let i = 0; i < samples.length; i++) samples[i] = Math.round(800 * Math.sin(i / 20));
      send({ type: "response.output_audio.delta", response_id: rid, item_id: itemId, output_index: 0, content_index: 0, delta: Buffer.from(samples.buffer).toString("base64") });
      await new Promise((r) => setTimeout(r, msPerWord));
    }
    send({ type: "response.output_audio.done", response_id: rid, item_id: itemId, output_index: 0, content_index: 0 });
    send({ type: "response.output_audio_transcript.done", response_id: rid, item_id: itemId, output_index: 0, content_index: 0, transcript: step.text });
    send({ type: "response.content_part.done", response_id: rid, item_id: itemId, output_index: 0, content_index: 0, part: { type: "audio", transcript: step.text } });
    const done = { ...item, status: "completed", content: [{ type: "output_audio", transcript: step.text }] };
    send({ type: "response.output_item.done", response_id: rid, output_index: 0, item: done });
    output.push(done);
  }
  for (const call of step.calls ?? []) {
    const itemId = id("fc");
    const item = { id: itemId, object: "realtime.item", type: "function_call", status: "completed", call_id: id("call"), name: call.name, arguments: JSON.stringify(call.args ?? {}) };
    send({ type: "response.output_item.added", response_id: rid, output_index: 1, item: { ...item, arguments: "", status: "in_progress" } });
    send({ type: "response.output_item.done", response_id: rid, output_index: 1, item });
    output.push(item);
  }
  send({ type: "response.done", response: { id: rid, object: "realtime.response", status: cancelled() ? "cancelled" : "completed", output, usage: { total_tokens: 1, input_tokens: 1, output_tokens: 0, input_token_details: { text_tokens: 1, audio_tokens: 0, cached_tokens: 0, cached_tokens_details: { text_tokens: 0, audio_tokens: 0 } }, output_token_details: { text_tokens: 0, audio_tokens: 0 } } } });
}
