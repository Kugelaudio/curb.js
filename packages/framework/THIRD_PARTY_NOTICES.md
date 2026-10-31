# Third-party notices

curb.js is licensed under the Apache License 2.0 (see `LICENSE`). It includes
the following third-party material, each under its own license.

## Silero VAD model

- File: `packages/framework/src/server/voice/assets/silero_vad.onnx`
- Source: https://github.com/snakers4/silero-vad (the same file is distributed in
  `@livekit/agents-plugin-silero`)
- License: MIT

```
MIT License

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.```

## shadcn/ui components

- Files: `packages/framework/src/components/ui/*` (generated with the shadcn CLI and modified)
- Source: https://github.com/shadcn-ui/ui
- License: MIT

```
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Dependencies installed from npm

Dependencies are not bundled in this repository; each is installed from npm under
its own license (predominantly MIT, Apache-2.0, BSD and ISC; `lightningcss` is
MPL-2.0).

curb.js runs on LiveKit. The LiveKit packages it uses (`@livekit/agents`, its
plugins, `@livekit/rtc-node` and `@livekit/protocol`) are licensed under the
Apache License 2.0. Two transitive pieces carry additional terms:

- `@livekit/local-inference`: its code is Apache-2.0; its model weights are under
  the LiveKit Model License, which permits use together with the LiveKit Agents
  framework, which is how curb.js uses them.
- `@livekit/av` platform binaries (for example `@livekit/av-darwin-arm64`) are
  LGPL-2.1-or-later, as they are built on FFmpeg. They are installed as separate,
  dynamically loaded packages.
