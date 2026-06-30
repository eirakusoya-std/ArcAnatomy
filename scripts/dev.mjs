import { spawn } from 'node:child_process';

const python = spawn('python3', ['-m', 'arc_anatomy.server'], {
  stdio: 'inherit',
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
});

const vite = spawn('vite', ['--host', '127.0.0.1'], {
  stdio: 'inherit',
  shell: true,
});

function stop() {
  python.kill();
  vite.kill();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

vite.on('exit', (code) => {
  python.kill();
  process.exit(code ?? 0);
});

python.on('exit', (code) => {
  vite.kill();
  process.exit(code ?? 0);
});
