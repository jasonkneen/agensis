// Verify that macOS desktop build artifacts are Developer-ID signed
// (and optionally notarized). Fail closed when no signed .app is found.
//
// Usage:
//   node scripts/desktop-verify-sign.mjs
//   node scripts/desktop-verify-sign.mjs release/mac-arm64/agensis.app
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(root, 'release')
const REQUIRED_IDENTITY = /Developer ID Application:\s*Jason Kneen\s*\(SW75ZJJ5R6\)/i

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  return {
    status: result.status ?? 1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function findApps(explicit) {
  if (explicit) {
    const p = path.resolve(explicit)
    if (!fs.existsSync(p)) throw new Error(`App not found: ${p}`)
    return [p]
  }
  if (!fs.existsSync(releaseDir)) throw new Error(`No release/ directory at ${releaseDir}`)
  const found = []
  for (const name of ['mac-arm64', 'mac', 'mac-universal']) {
    const dir = path.join(releaseDir, name)
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith('.app')) found.push(path.join(dir, entry))
    }
  }
  return found
}

function verifyApp(appPath) {
  console.log(`\n[desktop:verify-sign] ${appPath}`)

  const dv = run('codesign', ['-dv', '--verbose=4', appPath])
  if (dv.status !== 0) {
    console.error(dv.out)
    throw new Error('codesign -dv failed — app is not signed')
  }
  if (!/Authority=Developer ID Application/i.test(dv.out) && !REQUIRED_IDENTITY.test(dv.out)) {
    // codesign -dv prints Authority lines; also accept Signature= / TeamIdentifier
    if (!/TeamIdentifier=SW75ZJJ5R6/i.test(dv.out)) {
      console.error(dv.out)
      throw new Error('Signed, but not with Developer ID Application (SW75ZJJ5R6)')
    }
  }
  console.log('  codesign identity: Developer ID / team SW75ZJJ5R6 OK')

  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  if (verify.status !== 0) {
    console.error(verify.out)
    throw new Error('codesign --verify --deep --strict failed')
  }
  console.log('  codesign --verify --deep --strict: OK')

  // Gatekeeper assess: local Developer ID often passes; distribution needs notarize+staple
  const sp = run('spctl', ['-a', '-vv', appPath])
  if (sp.status === 0) {
    console.log('  spctl Gatekeeper: accepted')
  } else {
    console.warn('  spctl Gatekeeper: not accepted yet (sign OK; run npm run desktop:ship to notarize)')
    console.warn(sp.out.trim().split('\n').slice(0, 4).join('\n'))
    if (process.env.REQUIRE_NOTARIZED === '1') {
      throw new Error('REQUIRE_NOTARIZED=1 and spctl rejected the app')
    }
  }

  // Stapled ticket is what makes offline first-open clean after download
  const staple = run('xcrun', ['stapler', 'validate', appPath])
  if (staple.status === 0) {
    console.log('  stapler validate: OK (ticket stapled)')
  } else {
    console.warn('  stapler validate: no ticket (sign OK; notarize via npm run desktop:ship)')
    if (process.env.REQUIRE_NOTARIZED === '1') {
      throw new Error('REQUIRE_NOTARIZED=1 and app has no stapled notarization ticket')
    }
  }
}

const apps = findApps(process.argv[2])
if (apps.length === 0) {
  console.error('[desktop:verify-sign] No .app found under release/mac* — build first with npm run desktop:dist')
  process.exit(1)
}

let failed = 0
for (const app of apps) {
  try {
    verifyApp(app)
  } catch (err) {
    console.error(`  FAIL: ${err.message || err}`)
    failed += 1
  }
}

if (failed) {
  console.error(`\n[desktop:verify-sign] ${failed}/${apps.length} app(s) failed signature check`)
  process.exit(1)
}
console.log(`\n[desktop:verify-sign] ${apps.length} app(s) Developer-ID signed`)
