import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
mkdirSync(join(root, 'out'), { recursive: true });
cpSync(join(root, 'src', 'assets'), join(root, 'out', 'assets'), { recursive: true });
