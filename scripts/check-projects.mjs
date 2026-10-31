#!/usr/bin/env node
// Every Curb project under a directory passes `curb check` and `curb build`, so a change
// that breaks one fails CI instead of surprising the next person who opens it.
//
//   npm run check:examples    examples/, the projects in this repository
//   npm run check:compat      compat/projects/, projects frozen from older releases
//   node scripts/check-projects.mjs <dir>
//
// The test points it at a fixture tree to prove a broken project turns the run red.
//
// Runs after `npm ci` at the Curb root. Projects are found by listing the directory,
// never from a list kept here, so a new one is covered with no edit to this file:
//
//   - a directory with src/agent/ is a Curb project (the marker bin/curb.js and
//     resolveAgentDir use) and gets both commands;
//   - a directory with no src/agent/ that names curb in its package.json fails: it is
//     a broken project, and skipping it would drop it from CI without a red check;
//   - anything else (examples/overview is a Vite slide page) is printed as skipped.
//
// The CLI is wired the way scripts/self-host-smoke.mjs wires it:
// the in-repo framework's bin/curb.js (TypeScript source through tsx, no dist), run
// from the project directory, LIVEKIT_* and CURB_* removed from the environment, and
// the artifact written to a temporary directory that is removed after each build.
// `curb build` keeps its verification on: it starts the artifact and renders every
// skill, which is what catches a bundle that compiles and then does nothing.
//
// Every example gets both commands even after a failure, so one CI run names every
// broken example. Exit code is 1 when any command failed, any project is broken, or
// no project was found at all.
//
// Examples run CURB_EXAMPLES_CONCURRENCY at a time (default 4; a build is ~45 s on a CI
// runner). One example's check and build stay in order, and its CLI output is buffered
// and printed as one block when the example finishes, so parallel output never
// interleaves. Running them side by side shares no writable state: each build has its
// own --out under the work dir, `curb build` writes generated files inside its own
// project and verifies in a fresh mkdtemp, and the one fixed port (the LiveKit worker's
// health port 8081) binds only after the "starting worker" marker verify stops at.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const CURB_ROOT = path.resolve(import.meta.dirname, '..')
const CURB_CLI = path.join(CURB_ROOT, 'packages/framework/bin/curb.js')

// The smoke test's build budget; a build takes ~7 s on an M-series Mac.
const CHECK_TIMEOUT_MS = 120_000
const BUILD_TIMEOUT_MS = 240_000

const DEFAULT_CONCURRENCY = 4

// A package.json script that runs the curb CLI (`curb dev`, `curb check`, ...).
const RUNS_CURB = /(^|[\s;&|])curb(\s|$)/

export class NoProjectsError extends Error {}

function namesCurb(packageJsonPath) {
  if (!existsSync(packageJsonPath)) return false
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const scripts = Object.values(manifest.scripts ?? {})
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  return scripts.some((script) => RUNS_CURB.test(script)) || 'curb' in dependencies
}

/**
 * Sorts every directory under `examplesDir` into the three cases in the header.
 * Plain files are ignored: an example is a directory.
 */
export function classifyExamples(examplesDir) {
  const projects = []
  const skipped = []
  const broken = []
  for (const name of readdirSync(examplesDir).sort()) {
    const dir = path.join(examplesDir, name)
    if (!statSync(dir).isDirectory()) continue
    if (existsSync(path.join(dir, 'src', 'agent'))) {
      projects.push({ name, dir })
    } else if (namesCurb(path.join(dir, 'package.json'))) {
      broken.push({ name, reason: 'package.json runs or depends on curb, but there is no src/agent/' })
    } else {
      skipped.push({ name, reason: 'no src/agent/ and no curb in package.json, so not a Curb project' })
    }
  }
  return { projects, skipped, broken }
}

/** The environment the smoke test builds with: the caller's, minus every LiveKit and Curb setting. */
export function curbEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('LIVEKIT_') && !name.startsWith('CURB_')),
  )
}

/** How many examples run at once: CURB_EXAMPLES_CONCURRENCY, a positive integer, else 4. */
export function concurrencyFrom(env) {
  const raw = env.CURB_EXAMPLES_CONCURRENCY
  if (raw === undefined || raw === '') return DEFAULT_CONCURRENCY
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`CURB_EXAMPLES_CONCURRENCY must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return Number(raw)
}

/**
 * Runs check then build for every project through `runCommand(project, command)`,
 * which resolves `{ ok, detail, output? }`, `concurrency` projects at a time. Each
 * project's commands and output go to `log` as one block when that project finishes.
 * Returns one result per command, in project order whatever order they finished in.
 */
export async function checkProjects(projects, runCommand, log = console.log, concurrency = 1) {
  if (projects.length === 0) {
    throw new NoProjectsError('no Curb project found, so nothing was checked')
  }
  const perProject = new Array(projects.length)
  let next = 0
  const lane = async () => {
    while (next < projects.length) {
      const index = next++
      const project = projects[index]
      const lines = []
      const results = []
      for (const command of ['check', 'build']) {
        lines.push(`\n== ${project.name}: curb ${command}`)
        const began = performance.now()
        let outcome
        try {
          outcome = await runCommand(project, command)
        } catch (error) {
          outcome = { ok: false, detail: `threw: ${error.message}` }
        }
        const { ok, detail, output = '' } = outcome
        const seconds = (performance.now() - began) / 1000
        if (output) lines.push(output.replace(/\n$/, ''))
        results.push({ name: project.name, command, ok, detail, seconds })
        lines.push(`  ${ok ? 'ok  ' : 'FAIL'}  ${project.name}  curb ${command}  (${seconds.toFixed(1)}s)${ok ? '' : `: ${detail}`}`)
      }
      perProject[index] = results
      log(lines.join('\n'))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, lane))
  return perProject.flat()
}

/** 0 when every command passed and no project is broken, else 1. */
export function exitCode(results, broken) {
  return results.every((result) => result.ok) && broken.length === 0 ? 0 : 1
}

/** Runs the CLI to completion, stdout and stderr buffered together into `output`; never rejects. */
function runCli(args, cwd, env, timeoutMs, children) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CURB_CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      children.delete(child)
      resolve({ ok: false, detail: `could not start node: ${error.message}`, output })
    })
    // "close", not "exit": it fires after both pipes drained, so no output is lost.
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      children.delete(child)
      if (timedOut) resolve({ ok: false, detail: `timed out after ${timeoutMs / 1000}s`, output })
      else if (code === 0) resolve({ ok: true, detail: '', output })
      else resolve({ ok: false, detail: `exited ${code ?? signal}`, output })
    })
  })
}

async function main(examplesDir) {
  const startedAt = performance.now()
  const relativeExamples = path.relative(CURB_ROOT, examplesDir)
  const { projects, skipped, broken } = classifyExamples(examplesDir)
  const concurrency = concurrencyFrom(process.env)
  console.log(
    `curb examples: ${projects.length} project(s) under ${relativeExamples}, ${concurrency} at a time: ${projects.map((p) => p.name).join(', ')}`,
  )
  for (const { name, reason } of skipped) console.log(`  skip  ${name}: ${reason}`)
  for (const { name, reason } of broken) console.log(`  FAIL  ${name}: ${reason}`)

  const env = curbEnv(process.env)
  const workDir = mkdtempSync(path.join(tmpdir(), 'curb-examples-'))
  const children = new Set()
  // Synchronous, so it also runs on the "exit" event an uncaught error reaches: a
  // runaway build is killed and no ~175 MB artifact is left behind.
  const release = () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(workDir, { recursive: true, force: true })
  }
  process.on('exit', release)

  const runCommand = async (project, command) => {
    if (command === 'check') return runCli(['check'], project.dir, env, CHECK_TIMEOUT_MS, children)
    const outDir = path.join(workDir, project.name)
    try {
      return await runCli(['build', '--out', outDir], project.dir, env, BUILD_TIMEOUT_MS, children)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  }

  let results
  try {
    results = await checkProjects(projects, runCommand, console.log, concurrency)
  } catch (error) {
    if (!(error instanceof NoProjectsError)) throw error
    console.error(`\ncurb examples: FAIL\n  ${error.message} under ${relativeExamples}`)
    return 1
  } finally {
    release()
  }

  const code = exitCode(results, broken)
  const total = ((performance.now() - startedAt) / 1000).toFixed(1)
  const verdict = code === 0 ? 'PASS' : 'FAIL'
  console.log(`\ncurb examples: ${verdict}, ${results.length} command(s) over ${projects.length} project(s) in ${total}s`)
  for (const { name, command, ok, seconds, detail } of results) {
    console.log(`  ${seconds.toFixed(1).padStart(6)}s  ${ok ? 'ok  ' : 'FAIL'}  ${name}  curb ${command}${ok ? '' : `: ${detail}`}`)
  }
  for (const { name, reason } of broken) console.log(`          FAIL  ${name}: ${reason}`)
  return code
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: check-projects.mjs <dir>')
  process.exit(await main(path.resolve(process.argv[2])))
}
