# Compatibility projects

Each folder is a real project from an older Curb release, frozen as it was made. `npm run check:compat` runs `curb check` and `curb build` on each one with the current framework, so a change that would break someone's project fails CI.

Never edit a project here to make it pass. A failure means real projects break the same way, so either keep the old behaviour working, or make it a breaking release (`feat(framework)!:`) and delete the projects the new major no longer supports.

| Project | From |
| --- | --- |
| `1.4.33` | the default scaffold of the oldest release that still passes |
| `1.14.1` | the default scaffold of a recent release |
| `1.14.1-insurance` | `examples/insurance-agent`, which uses more of the API than a scaffold |

Projects from before 1.4.33 fail with `AGENT_HOME_SKILL_REMOVED`, which names the fix.

To add a project after a release, copy `src/`, `context/`, `package.json`, `tsconfig.json` and `.gitignore` from that release's template or example, with the template's placeholders filled in.
