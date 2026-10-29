/**
 * Azure Speech streaming STT as a LiveKit agents STT plugin (there is no
 * first-party Azure plugin in agents-js yet). Continuous recognition over a
 * push stream, same SDK usage as the classic `azure-stt.ts` path; the base
 * class resamples inbound room audio to 16 kHz for us.
 */

import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { type APIConnectOptions, normalizeLanguage, stt } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { azureLocales } from "../azure-stt.js";
import { logError, logInfo } from "../../log.js";
import type { CallReporter } from "../../../hosted/call-reporter.js";

const AZURE_SAMPLE_RATE = 16000;

/**
 * Make the Speech SDK use the `ws` package instead of Node's built-in WebSocket.
 *
 * `WebsocketMessageAdapter` prefers `globalThis.WebSocket` and only falls back to `ws`
 * when it is undefined. Node 22 shipped a built-in one, and its HTTP/2 path cannot reach
 * Azure Speech: the socket closes 1006 "Unable to contact server" before a single
 * transcript arrives. Deleting the global is what the SDK's own fallback is written for.
 *
 * Done when the first Azure STT is constructed rather than around each recognizer, because
 * toggling a global per stream would race the moment two calls start together. Never at
 * module load: `server/main.ts` imports this file in every Curb server, voice or not, and
 * a process that never transcribes still needs the built-in. supabase-js builds its
 * realtime client from it, so removing it at boot made every Supabase Storage upload in a
 * text-only agent throw "native WebSocket not found".
 *
 * Remove when the SDK supports an explicit transport, or when Node's WebSocket can carry
 * this connection. Verified against microsoft-cognitiveservices-speech-sdk@1.50.0 on
 * Node 26: identical calls transcribe correctly with the global removed and fail without.
 */
function preferWsPackageForSpeechSdk(): void {
  const globals = globalThis as { WebSocket?: unknown };
  if (globals.WebSocket !== undefined) {
    delete globals.WebSocket;
  }
}

export type AzureSttPluginConfig = {
  key: string;
  region: string;
  /** Kugel short code(s); comma-separated enables continuous auto-detect. */
  language: string;
  /** Trailing silence before Azure closes a segment and emits a final. */
  segmentationSilenceTimeoutMs?: number;
  /** HTTP CONNECT proxy supplied by the hosted runner's egress policy. */
  proxyUrl?: string;
  /**
   * THIS CALL'S reporter. Carried on the plugin config because a runner may serve several
   * calls at once, each with its own STT stream and its own conversation.
   */
  reporter?: CallReporter;
};

export function applyAzureSpeechProxy(
  speechConfig: Pick<sdk.SpeechConfig, "setProxy">,
  proxyUrl: string | undefined,
): void {
  if (!proxyUrl) return;
  const proxy = new URL(proxyUrl);
  if (!(["http:", "https:"] as string[]).includes(proxy.protocol) || !proxy.hostname) {
    throw new Error("Azure Speech proxy must be an absolute HTTP(S) URL.");
  }
  speechConfig.setProxy(
    proxy.hostname,
    Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
    decodeURIComponent(proxy.username),
    decodeURIComponent(proxy.password),
  );
}

export class AzureSTT extends stt.STT {
  label = "azure.STT";
  readonly config: AzureSttPluginConfig;

  constructor(config: AzureSttPluginConfig) {
    super({ streaming: true, interimResults: true });
    this.config = config;
    preferWsPackageForSpeechSdk();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async _recognize(_buffer: unknown): Promise<stt.SpeechEvent> {
    throw new Error("Azure STT is streaming-only; use stream().");
  }

  stream(options?: { connOptions?: APIConnectOptions }): AzureSpeechStream {
    return new AzureSpeechStream(this, this.config, options?.connOptions);
  }
}

export class AzureSpeechStream extends stt.SpeechStream {
  label = "azure.SpeechStream";
  private readonly config: AzureSttPluginConfig;

  constructor(sttImpl: AzureSTT, config: AzureSttPluginConfig, connOptions?: APIConnectOptions) {
    super(sttImpl, AZURE_SAMPLE_RATE, connOptions);
    this.config = config;
  }

  protected async run(): Promise<void> {
    const format = sdk.AudioStreamFormat.getWaveFormatPCM(AZURE_SAMPLE_RATE, 16, 1);
    const push = sdk.AudioInputStream.createPushStream(format);
    const audioConfig = sdk.AudioConfig.fromStreamInput(push);
    const speechConfig = sdk.SpeechConfig.fromSubscription(this.config.key, this.config.region);
    applyAzureSpeechProxy(speechConfig, this.config.proxyUrl);
    const timeout = this.config.segmentationSilenceTimeoutMs ?? 300;
    if (timeout > 0) {
      speechConfig.setProperty(
        sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
        String(timeout),
      );
    }

    const locales = azureLocales(this.config.language);
    let recognizer: sdk.SpeechRecognizer;
    if (locales.length > 1) {
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous");
      const autoDetect = sdk.AutoDetectSourceLanguageConfig.fromLanguages(locales);
      recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetect, audioConfig);
    } else {
      speechConfig.speechRecognitionLanguage = locales[0]!;
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    }

    const emit = (type: stt.SpeechEventType, text?: string) => {
      if (this.queue.closed) return;
      const event: stt.SpeechEvent = { type };
      if (text !== undefined) {
        event.alternatives = [
          {
            language: normalizeLanguage(locales[0]!),
            text,
            startTime: 0,
            endTime: 0,
            confidence: 1,
          },
        ];
      }
      this.queue.put(event);
    };

    recognizer.recognizing = (_sender, event) => {
      const text = event.result.text?.trim();
      if (text) emit(stt.SpeechEventType.INTERIM_TRANSCRIPT, event.result.text);
    };
    recognizer.recognized = (_sender, event) => {
      if (event.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
      const text = event.result.text?.trim();
      if (text) {
        logInfo("voice", `stt final: ${JSON.stringify(text)}`);
        // The caller's half of the transcript. Finals only: interim revisions are a
        // recognition detail, and a hosted reader wants the sentence, not the guesses.
        this.config.reporter?.turn({ speaker: "caller", text, final: true });
        emit(stt.SpeechEventType.FINAL_TRANSCRIPT, event.result.text);
        emit(stt.SpeechEventType.END_OF_SPEECH);
      }
    };
    recognizer.speechStartDetected = () => emit(stt.SpeechEventType.START_OF_SPEECH);
    // A cancellation FAILS the stream. It used to be logged and swallowed, and the
    // consequence was the worst kind of failure this codebase has: the recognizer would
    // report `started`, the loop below would log `receiving audio` and go on consuming
    // caller speech forever, the agent would publish a track of digital silence, and the
    // session would sit healthy in `assigned` with nothing anywhere saying the call was
    // deaf. A caller talks to a wall and every dashboard reads green.
    let cancellation: Error | undefined;
    recognizer.canceled = (_sender, event) => {
      if (event.reason !== sdk.CancellationReason.Error) return;
      const detail =
        `Azure STT canceled (${sdk.CancellationErrorCode[event.errorCode]}): ${event.errorDetails}`;
      logError("voice", detail);
      cancellation ??= new Error(detail);
      // Closing the queue ends the stream rather than leaving a consumer waiting on
      // transcripts that will never arrive.
      if (!this.queue.closed) this.queue.close();
    };

    await new Promise<void>((resolve, reject) => {
      recognizer.startContinuousRecognitionAsync(resolve, (error) =>
        reject(new Error(`Azure STT failed to start: ${error}`)),
      );
    });

    logInfo("voice", "azure stt stream started");
    let framesIn = 0;
    try {
      for await (const item of this.input) {
        if (item === stt.SpeechStream.FLUSH_SENTINEL) continue;
        const frame = item as AudioFrame;
        framesIn += 1;
        if (framesIn === 1) {
          logInfo("voice", `azure stt receiving audio (rate=${frame.sampleRate} ch=${frame.channels})`);
        }
        // The SDK wants an ArrayBuffer slice it can own.
        const view = new Int16Array(frame.data.buffer, frame.data.byteOffset, frame.data.length);
        const copy = new ArrayBuffer(view.byteLength);
        new Uint8Array(copy).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        push.write(copy);
      }

      // The stream ended. If it ended because the recognizer was cancelled, that is a
      // FAILURE and the caller has to hear about it — returning normally here is what
      // let a deaf call look like a healthy one.
      if (cancellation) throw cancellation;
    } finally {
      push.close();
      await new Promise<void>((resolve) => {
        recognizer.stopContinuousRecognitionAsync(
          () => {
            recognizer.close();
            resolve();
          },
          () => {
            // KEEP-JUSTIFIED: teardown after the session already ended; there
            // is no caller left to surface a stop failure to.
            recognizer.close();
            resolve();
          },
        );
      });
    }
  }
}
