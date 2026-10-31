import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { agentPrompt, CREATE_COMMAND, NODE_FLOOR } from './agent-prompt'

const repo = new URL('../../', import.meta.url)
const inRepo = (path: string) => new URL(path, repo)
const prompt = agentPrompt(new URL('https://curbjs.com'))

describe('the prompt for coding agents', () => {
  it('names the Node floor the framework declares', () => {
    expect(NODE_FLOOR).toMatch(/^\d+\.\d+$/)
    expect(prompt).toContain(`${NODE_FLOOR} or newer`)
  })

  it('links the docs entry points the site builds', () => {
    expect(prompt).toContain('https://curbjs.com/docs/')
    for (const name of ['llms.txt', 'llms-full.txt']) {
      expect(prompt).toContain(`https://curbjs.com/${name}`)
      expect(existsSync(inRepo(`website/src/pages/${name}.ts`))).toBe(true)
    }
  })

  it('points at the docs the framework package ships', () => {
    const { files } = JSON.parse(readFileSync(inRepo('packages/framework/package.json'), 'utf8')) as { files: string[] }
    expect(files).toContain('docs')
    expect(prompt).toContain('node_modules/curb/docs/agent-guide/')
    expect(existsSync(inRepo('packages/framework/docs/agent-guide/README.md'))).toBe(true)
  })

  it('names the AGENTS.md the scaffold writes', () => {
    expect(prompt).toContain(CREATE_COMMAND)
    expect(prompt).toContain('AGENTS.md')
    expect(existsSync(inRepo('packages/create-curb.js/templates/default/AGENTS.md'))).toBe(true)
  })

  it('names only commands the CLI has', () => {
    const cli = readFileSync(inRepo('packages/framework/src/cli/main.ts'), 'utf8')
    const usage = cli.slice(cli.indexOf('const USAGE'), cli.indexOf('`;', cli.indexOf('const USAGE')))
    const commands = [...prompt.matchAll(/npx curb (\w+)/g)].map((match) => match[1]!)
    expect(new Set(commands)).toEqual(new Set(['check', 'say', 'test', 'dev', 'login']))
    for (const command of commands) expect(usage).toMatch(new RegExp(`^  ${command}\\b`, 'm'))
  })

  it('stays short enough to paste', () => {
    expect(prompt.length).toBeLessThan(2000)
  })
})
