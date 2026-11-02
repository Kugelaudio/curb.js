# `azure`

Speech-to-text. Key: `AZURE_SPEECH_KEY`.

```ts
import { azure } from "curb/providers";

azure.stt(options?: AzureSttOptions): SttDescriptor;
```

## Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `language` | `string` | | The language |
| `region` | `string` | `AZURE_SPEECH_REGION`, else `eastus` | The Azure region |
| `segmentationMs` | `number` | `300` | The trailing silence before Azure ends an utterance |

## Example

```tsx
<Agent stt={azure.stt({ language: "de-DE", region: "westeurope" })} />
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `azure` introduced |
