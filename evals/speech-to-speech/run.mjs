#!/usr/bin/env node
// Runs the eval on every agent under agents/, one process per agent, all at once, then prints the
// summary. Each agent's output goes to <out>/<agent>.<path>.log.
//
//   node run.mjs text  [--runs 3] [--out .results/<name>] [--agents clinic,shop] [-- <runner options>]
//   node run.mjs voice [--runs 1] ...
//   node run.mjs both  ...
//
// The agents read their keys from the environment or their .env (see agents/*/.env.example).

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const which = args[0]
if (!['text', 'voice', 'both'].includes(which)) {
  console.error('usage: node run.mjs text|voice|both [--runs n] [--out dir] [--agents a,b] [-- runner options]')
  process.exit(1)
}
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}
const passThrough = args.includes('--') ? args.slice(args.indexOf('--') + 1) : []
const out = resolve(option('--out', join(here, '.results', new Date().toISOString().replace(/[:.]/g, '-'))))
const agents = option('--agents', readdirSync(join(here, 'agents')).join(',')).split(',')
const paths = which === 'both' ? ['text', 'voice'] : [which]
mkdirSync(out, { recursive: true })

function runAgent(agent, path) {
  const runs = option('--runs', path === 'text' ? '3' : '1')
  const log = createWriteStream(join(out, `${agent}.${path}.log`))
  const child = spawn('npx', ['curb', 'run', `../../harness/${path}.ts`, '--runs', runs, '--out', out, ...passThrough], {
    cwd: join(here, 'agents', agent),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  return new Promise((done) => child.on('exit', (code) => {
    console.error(`${agent} ${path}: exit ${code}`)
    done(code)
  }))
}

for (const path of paths) {
  console.error(`${path}: ${agents.join(', ')} -> ${out}`)
  await Promise.all(agents.map((agent) => runAgent(agent, path)))
}
const summary = spawn('npx', ['tsx', join(here, 'harness', 'summarize.ts'), out], { stdio: 'inherit' })
summary.on('exit', (code) => process.exit(code ?? 1))
