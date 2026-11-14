# Third-party notices

marcsh includes code ported from, or modelled on, the projects below. Their licenses ask for the copyright and permission
notice to be kept in every copy, so it is reproduced here unchanged.

## my-pi-setup (davi7)

Upstream: https://github.com/davis7dotsh/my-pi-setup

Ported or adapted in marcsh (paths under `packages/cli/src/`):

- `lib/background/terminals.ts`: from `extensions/background-terminals/src/manager.ts` and `src/domain.ts`
- `lib/background/output.ts`: from `extensions/background-terminals/src/output.ts` and `src/ui/output-view.ts`
- `lib/background/terminal-prompt.ts`: from `extensions/background-terminals/src/prompt.ts`
- `lib/engine/pi-bg-tools.ts`: from `extensions/background-terminals/index.ts`
- `lib/engine/pi-tool-timeout.ts`: from `extensions/shared/tool-call-timeout.ts`
- `components/dialogs/ps-dialog.tsx`: follows `extensions/background-terminals/src/ui/ps.ts`
- `components/dialogs/subagents-dialog.tsx`: follows the background subagents "takeover" view
- `lib/background/hub.ts`: its result delivery follows `result-delivery.ts`
- `lib/background/subagents.ts`: follows the idea of davi7's background subagents

```text
MIT License

Copyright (c) 2026 Benjamin Davis

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
