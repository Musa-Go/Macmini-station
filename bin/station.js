#!/usr/bin/env node
import { main } from '../src/cli.js'

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
})

process.exitCode = code