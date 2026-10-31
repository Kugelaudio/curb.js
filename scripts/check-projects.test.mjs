import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  NoProjectsError,
  checkProjects,
  classifyExamples,
  concurrencyFrom,
  curbEnv,
  exitCode,
} from './check-projects.mjs'

const SCRIPT = fileURLToPath(new URL('./check-projects.mjs', import.meta.url))

function examplesTree(t, layout) {
  const root = mkdtempSync(path.join(tmpdir(), 'curb-examples-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, { agent = false, packageJson } = {}] of Object.entries(layout)) {
    mkdirSync(path.join(root, name, agent ? 'src/agent' : ''), { recursive: true })
    if (packageJson) writeFileSync(path.join(root, name, 'package.json'), JSON.stringify(packageJson))
  }
  return root
}

test('a directory with src/agent/ is a project, a curb package without one is broken, the rest is skipped', (t) => {
  const root = examplesTree(t, {
    'b-agent': { agent: true, packageJson: { scripts: { check: 'curb check' } } },
    'a-agent': { agent: true },
    slides: { packageJson: { scripts: { build: 'vite build' }, dependencies: { vite: '^7' } } },
    renamed: { packageJson: { scripts: { dev: 'curb dev' } } },
    'depends-only': { packageJson: { dependencies: { curb: 'file:../..' } } },
    'no-manifest': {},
  })
  writeFileSync(path.join(root, 'README.md'), 'not an example')

  const { projects, skipped, broken } = classifyExamples(root)

  assert.deepEqual(projects.map((p) => p.name), ['a-agent', 'b-agent'])
  assert.equal(projects[0].dir, path.join(root, 'a-agent'))
  assert.deepEqual(broken.map((b) => b.name), ['depends-only', 'renamed'])
  assert.deepEqual(skipped.map((s) => s.name), ['no-manifest', 'slides'])
})

test('a script that merely contains the letters curb does not make a project', (t) => {
  const root = examplesTree(t, { tool: { packageJson: { scripts: { lint: 'curbstone --fix' } } } })
  assert.deepEqual(classifyExamples(root).broken, [])
})

test('the real directories each hold a project, so CI checks something', () => {
  for (const dir of ['../examples', '../compat/projects']) {
    assert.ok(classifyExamples(fileURLToPath(new URL(dir, import.meta.url))).projects.length > 0)
  }
})

test('every project gets check then build, and a failure does not stop the rest', async () => {
  const calls = []
  const results = await checkProjects(
    [{ name: 'one' }, { name: 'two' }],
    async (project, command) => {
      calls.push(`${project.name}:${command}`)
      return project.name === 'one' && command === 'check' ? { ok: false, detail: 'exited 1' } : { ok: true, detail: '' }
    },
    () => {},
  )

  assert.deepEqual(calls, ['one:check', 'one:build', 'two:check', 'two:build'])
  assert.deepEqual(
    results.filter((r) => !r.ok).map((r) => [r.name, r.command, r.detail]),
    [['one', 'check', 'exited 1']],
  )
})

test('a failing example run beside passing ones still turns the run red, and every failure is named', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let inFlight = 0
  let maxInFlight = 0
  const blocks = []
  const results = await checkProjects(
    [{ name: 'pass-a' }, { name: 'bad-check' }, { name: 'pass-b' }, { name: 'bad-build' }],
    async (project, command) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // The failures finish last and first, so neither the slowest nor the fastest
      // example decides the verdict by accident.
      await sleep(project.name === 'bad-check' ? 40 : 10)
      inFlight -= 1
      const fails = `${project.name}:${command}` === 'bad-check:check' || `${project.name}:${command}` === 'bad-build:build'
      return fails
        ? { ok: false, detail: 'exited 1', output: `${project.name} ${command} said no\n` }
        : { ok: true, detail: '', output: `${project.name} ${command} fine\n` }
    },
    (block) => blocks.push(block),
    3,
  )

  assert.ok(maxInFlight > 1, `ran one at a time (max in flight ${maxInFlight})`)
  assert.ok(maxInFlight <= 3, `exceeded the pool (max in flight ${maxInFlight})`)
  assert.equal(exitCode(results, []), 1)
  assert.deepEqual(
    results.map((r) => `${r.name}:${r.command}:${r.ok ? 'ok' : 'FAIL'}`),
    [
      'pass-a:check:ok', 'pass-a:build:ok',
      'bad-check:check:FAIL', 'bad-check:build:ok',
      'pass-b:check:ok', 'pass-b:build:ok',
      'bad-build:check:ok', 'bad-build:build:FAIL',
    ],
  )
  // One block per example, holding that example's output and nobody else's.
  assert.equal(blocks.length, 4)
  for (const block of blocks) {
    const name = block.match(/== (\S+): curb check/)[1]
    assert.ok(!block.replaceAll(name, '').match(/pass-a|pass-b|bad-check|bad-build/), block)
  }
  assert.match(blocks.find((b) => b.includes('== bad-check:')), /bad-check check said no\n {2}FAIL {2}bad-check {2}curb check/)
})

test('a command that throws is a failure of that example, not of the run', async () => {
  const results = await checkProjects(
    [{ name: 'one' }, { name: 'two' }],
    async (project) => {
      if (project.name === 'one') throw new Error('rm failed')
      return { ok: true, detail: '' }
    },
    () => {},
    2,
  )
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => [r.name, r.detail]), [
    ['one', 'threw: rm failed'],
    ['one', 'threw: rm failed'],
  ])
  assert.equal(exitCode(results, []), 1)
  assert.equal(exitCode(results.filter((r) => r.ok), []), 0)
  assert.equal(exitCode([], [{ name: 'renamed' }]), 1)
})

test('concurrency is 4 by default and CURB_EXAMPLES_CONCURRENCY overrides it with a positive integer only', () => {
  assert.equal(concurrencyFrom({}), 4)
  assert.equal(concurrencyFrom({ CURB_EXAMPLES_CONCURRENCY: '' }), 4)
  assert.equal(concurrencyFrom({ CURB_EXAMPLES_CONCURRENCY: '2' }), 2)
  for (const bad of ['0', '-1', '1.5', 'two', ' 2']) {
    assert.throws(() => concurrencyFrom({ CURB_EXAMPLES_CONCURRENCY: bad }), /positive integer/)
  }
})

test('no project at all is a failure, not a green run over nothing', async () => {
  await assert.rejects(checkProjects([], async () => ({ ok: true, detail: '' }), () => {}), NoProjectsError)
})

// Runs the real CLI, so it needs `npm ci` at the Curb root first (the framework
// unit does that before this test). Both commands fail in well under a second on an
// empty src/agent/, before any bundling.
test('broken examples checked side by side turn the whole run red and are all named in the summary', (t) => {
  const root = examplesTree(t, {
    empty: { agent: true },
    hollow: { agent: true },
    renamed: { packageJson: { scripts: { check: 'curb check' } } },
  })

  const run = spawnSync(process.execPath, [SCRIPT, root], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, CURB_EXAMPLES_CONCURRENCY: '2' },
  })

  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout, /2 project\(s\) under .*, 2 at a time: empty, hollow/)
  assert.match(run.stdout, /curb examples: FAIL, 4 command\(s\) over 2 project\(s\)/)
  for (const name of ['empty', 'hollow']) {
    assert.match(run.stdout, new RegExp(`FAIL {2}${name} {2}curb check: exited 1`))
    assert.match(run.stdout, new RegExp(`FAIL {2}${name} {2}curb build: exited 1`))
  }
  assert.match(run.stdout, /FAIL {2}renamed: package\.json runs or depends on curb/)
})

test('the build environment drops LiveKit and Curb settings and keeps the rest', () => {
  assert.deepEqual(
    curbEnv({ PATH: '/bin', LIVEKIT_API_KEY: 'k', CURB_PROFILE: 'p', HOME: '/h' }),
    { PATH: '/bin', HOME: '/h' },
  )
})
