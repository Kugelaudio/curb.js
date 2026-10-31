import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codeBlock, plainSkill, requestBlock, skillBranches, stateSteps } from './requests'

const guide = readFileSync(
  fileURLToPath(new URL('../../packages/framework/docs/agent-guide/what-the-model-receives.md', import.meta.url)),
  'utf8',
)

describe('the landing page requests', () => {
  it('reads the steps and the skill from the guide', () => {
    expect(requestBlock(guide, 'states')).toContain('tool: open_claim(what*) [page]')
    expect(codeBlock(guide, 'src/agent/report-claim/skill.tsx')).toContain('name="verify_policy"')
  })

  it('refuses a block the guide no longer has, instead of showing nothing', () => {
    expect(() => requestBlock(guide, 'gone')).toThrow('no request block')
    expect(() => codeBlock(guide, 'src/gone.tsx')).toThrow('no code block')
  })

  it('plays the guide\'s two steps, each tool only in its own step', () => {
    const steps = stateSteps(requestBlock(guide, 'states'))
    expect(steps.map((step) => step.caller)).toEqual(['A pipe burst at home', 'It’s 4711'])
    expect(steps.map((step) => step.values)).toEqual([[['verified', 'false']], [['verified', 'true']]])
    expect(steps[0]!.lines).toContain('tool: verify_policy(policy*) [page]')
    expect(steps[1]!.lines).toContain('tool: open_claim(what*) [page]')
    expect(steps[1]!.lines.join()).not.toContain('verify_policy')
  })

  it('prints a short skill with its two states', () => {
    const skill = plainSkill(codeBlock(guide, 'src/agent/report-claim/skill.tsx, with a switch'))
    expect(skill.split('\n')).toHaveLength(12)
    expect(skill).toContain('useState(false)')
    const branches = skillBranches(skill)
    const text = (branch: number) => skill.split('\n').filter((_, index) => branches[index] === branch).join('\n')
    expect(text(1)).toContain('onSubmit={() => { setVerified(true); … }} />')
    expect(text(1)).not.toContain('open_claim')
    expect(text(2)).toContain('<Tool name="open_claim" … />')
  })
})
