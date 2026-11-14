/**
 * The landing page shows the requests of what-the-model-receives.md, read from the guide at build
 * time. The framework's what-the-model-receives test proves those blocks verbatim, so the landing
 * page cannot show a request Curb does not send.
 */

/** One `<!-- request: name -->` block of the guide. */
export function requestBlock(markdown: string, name: string): string {
  const match = new RegExp(`<!-- request: ${name} -->\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``).exec(markdown)
  if (!match) throw new Error(`what-the-model-receives.md has no request block "${name}"`)
  return match[1]!
}

/** The code fence of the guide that opens with `// <file>`. */
export function codeBlock(markdown: string, file: string): string {
  const match = new RegExp(`\`\`\`tsx\\n// ${file}\\n([\\s\\S]*?)\\n\`\`\``).exec(markdown)
  if (!match) throw new Error(`what-the-model-receives.md has no code block for ${file}`)
  return match[1]!
}

/** One step of a call: what the caller said, the tool the model called, the store's values and the skill's lines after it. */
export type StateStep = { caller: string; tool: string; values: [string, string][]; lines: string[] }

/** The guide's `states` block: a heading per step, then that step's lines. */
export function stateSteps(block: string): StateStep[] {
  const steps = block.split(/^=== /m).slice(1).map((part): StateStep => {
    const [heading, state, ...lines] = part.trim().split('\n')
    const match = /^(.*): (\w+)$/.exec(heading!)
    if (!match) throw new Error(`The states block has no caller and tool in "${heading}"`)
    if (!state?.startsWith('state: ')) throw new Error(`The states block has no values under "${heading}"`)
    const values = state.slice(7).split(', ').map((pair) => pair.split(' = ') as [string, string])
    return { caller: match[1]!.replaceAll("'", '’'), tool: match[2]!, values, lines }
  })
  if (steps.length !== 2) throw new Error('The states block no longer has the two steps this page plays')
  return steps
}

/** The skill as the page prints it: each tool by name, and only the call that flips the switch. */
export function plainSkill(code: string): string {
  return code.replace(/<Tool\s+name="(\w+)"([\s\S]*?)\/>/g, (_tool, name: string, props: string) => {
    const flips = /onSubmit=.*setVerified.*/.exec(props)?.[0].replace(' return { ok: true };', ' …')
    return flips ? `<Tool name="${name}" …\n      ${flips} />` : `<Tool name="${name}" … />`
  })
}

/** Which state of the skill each line belongs to, by line: first the check, then the rest. */
export function skillBranches(code: string): (number | null)[] {
  let branch = 0
  let open = false
  return code.split('\n').map((line) => {
    if (/<>$/.test(line)) {
      branch += 1
      open = true
      return branch
    }
    if (!open) return null
    if (/<\/>;$/.test(line)) open = false
    return branch
  })
}
