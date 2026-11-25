import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const gatewayDirectory = join(root, 'gateway');
const targets = [
  ['linux', 'amd64'],
  ['linux', 'arm64'],
  ['darwin', 'amd64'],
  ['darwin', 'arm64'],
  ['windows', 'amd64'],
  ['windows', 'arm64'],
];

for (const [platform, architecture] of targets) {
  const executable = platform === 'windows' ? 'zen-transport.exe' : 'zen-transport';
  const directory = join(root, 'bin', `${platform}-${architecture}`);
  mkdirSync(directory, { recursive: true });
  const output = join(directory, executable);
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', output, './cmd/zen-transport'], {
    cwd: gatewayDirectory,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: platform, GOARCH: architecture },
    stdio: 'inherit',
  });
  if (platform !== 'windows') {
    chmodSync(output, 0o755);
  }
  console.log(`${platform}-${architecture}: ${output}`);
}
