#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const root = path.join(__dirname, '..');
const binary = path.join(os.tmpdir(), `livescribe-host-test-${process.pid}`);
execFileSync('swiftc', ['-O', path.join(root, 'companion/macos/LiveScribeHost.swift'), '-o', binary]);

const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const message = Buffer.from(JSON.stringify({ type: 'ping' }));
const header = Buffer.alloc(4);
header.writeUInt32LE(message.length);
let output = Buffer.alloc(0);
child.stdout.on('data', chunk => { output = Buffer.concat([output, chunk]); });
child.on('close', () => {
  try { fs.unlinkSync(binary); } catch (e) {}
  const length = output.length >= 4 ? output.readUInt32LE(0) : 0;
  const response = length ? JSON.parse(output.subarray(4, 4 + length).toString('utf8')) : {};
  const ok = response.ok === true;
  console.log('native framing ping'.padEnd(42), ok ? 'PASS' : 'FAIL');
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
});
child.stdin.end(Buffer.concat([header, message]));
