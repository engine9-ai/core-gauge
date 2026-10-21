#!/usr/bin/env node
import { run } from '../lib/cli.js';

const code = await run(process.argv.slice(2));
if (typeof code === 'number' && code !== 0) process.exitCode = code;
