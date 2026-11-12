# Security policy

## Supported versions

Security fixes go into the latest stable release of `curb.js` and `create-curb.js`, the version on
npm's `latest` dist-tag. A fix ships as a new release, so `curb upgrade` is how a project gets it.

| Version | Supported |
| --- | --- |
| Latest stable (`latest`) | Yes |
| Older stable releases | No, upgrade to the latest |
| Previews (`preview`, `<version>-preview.<n>`) | No |

## Reporting a vulnerability

Please do not report a security problem in a public issue, discussion or pull request.

1. **Report it privately on GitHub:** open
   [Report a vulnerability](https://github.com/Kugelaudio/curb.js/security/advisories/new), also
   under **Security > Report a vulnerability** on this repository. Only you and the maintainers see
   the report, and we can work on the fix with you there.
2. **Or email hello@kugelaudio.com** if you cannot use GitHub's form.

Tell us the affected version, how to reproduce the problem and what an attacker gains from it. Leave
out real credentials and other people's data.

## What to expect

- We confirm your report within 5 working days.
- We check it, tell you whether we accept it, and keep you posted on the fix.
- An accepted problem is fixed in a new stable release, and we say what it fixed once projects can
  upgrade. We credit you if you would like that.
- Please keep the details private until that release is out.

## Scope

In scope is the code in this repository and what it publishes to npm:

- the `curb.js` and `create-curb.js` packages, and the project the scaffolder writes
- the `curb` CLI, the agent server, the voice hosts, the host protocol and `curb/client`
- what `curb build` produces, including anything it leaks into an artifact
- the workflows in `.github/workflows/`

Out of scope:

- the code, prompts and tools a project writes on top of Curb
- hosted services and the providers an agent calls; for KugelAudio's own services, write to the same
  address
- `curb dev` exposed beyond your own machine, which it is not built for
- a dependency's advisory that Curb cannot reach; the ones known today are listed in `AGENTS.md`
- the demo data in `examples/`
