// The layout rule: src/core is shared, src/tb is test-broker, src/ci is the opt-in ci-broker. test-broker and the
// core never import ci-broker code, and the core never imports test-broker code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const SRC = join(import.meta.dirname, '..', '..', 'src')

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []))
}

function badImports(part: string, forbidden: string[]): string[] {
  const bad: string[] = []
  for (const f of tsFiles(join(SRC, part)))
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      const to = relative(SRC, resolve(dirname(f), m[1]))
      if (forbidden.some((p) => to.startsWith(`${p}/`))) bad.push(`${relative(SRC, f)} imports ${to}`)
    }
  return bad
}

test('src/tb imports nothing from src/ci', () => assert.deepEqual(badImports('tb', ['ci']), []))
test('src/core imports nothing from src/ci or src/tb', () => assert.deepEqual(badImports('core', ['ci', 'tb']), []))
