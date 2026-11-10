'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_MODEL = 'mflux-community/flux-1-dev-kontext-mflux-q4';
const DEFAULT_WIDTH = 768;
const DEFAULT_HEIGHT = 768;
const DEFAULT_STEPS = 20;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

function resolveImageEditProvider(env = process.env) {
  const raw = String(env.IMAGE_EDIT_PROVIDER || 'local')
    .trim()
    .toLowerCase();
  if (raw === 'gemini') return 'gemini';
  if (raw === 'local' || raw === 'flux' || raw === 'mflux' || raw === 'kontext') return 'local';
  return 'local';
}

function truthy(value) {
  const text = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function buildMfluxKontextArgs({ imagePath, outputPath, prompt, env = process.env } = {}) {
  const model = String(env.MFLUX_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const width = Math.max(256, Number(env.MFLUX_WIDTH) || DEFAULT_WIDTH);
  const height = Math.max(256, Number(env.MFLUX_HEIGHT) || DEFAULT_HEIGHT);
  const steps = Math.max(4, Number(env.MFLUX_STEPS) || DEFAULT_STEPS);
  const guidance = Number(env.MFLUX_GUIDANCE);
  const lowRam = env.MFLUX_LOW_RAM == null ? true : truthy(env.MFLUX_LOW_RAM);
  const args = [
    '--model',
    model,
    '--base-model',
    'dev-kontext',
    '--image-path',
    imagePath,
    '--prompt',
    String(prompt || ''),
    '--width',
    String(width),
    '--height',
    String(height),
    '--steps',
    String(steps),
    '--output',
    outputPath,
  ];
  if (Number.isFinite(guidance) && guidance > 0) {
    args.push('--guidance', String(guidance));
  }
  if (lowRam) args.push('--low-ram');
  return args;
}

function resolveMfluxBinary(env = process.env) {
  const configured = String(env.MFLUX_BIN || '').trim();
  if (configured) return configured;
  const homeBin = path.join(os.homedir(), '.local', 'bin', 'mflux-generate-kontext');
  if (fs.existsSync(homeBin)) return homeBin;
  return 'mflux-generate-kontext';
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  return 'image/png';
}

function runMflux(args, { env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const bin = resolveMfluxBinary(env);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Local FLUX Kontext timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'mflux-generate-kontext not found. Install with: uv tool install --upgrade mflux',
          ),
        );
        return;
      }
      reject(new Error(`Local FLUX Kontext failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = (stderr || stdout || `exit ${code}`).trim().slice(-1200);
      reject(new Error(`Local FLUX Kontext failed: ${detail}`));
    });
  });
}

async function editImageWithLocalFlux({ imageBuffer, prompt, env = process.env } = {}) {
  if (!imageBuffer || !imageBuffer.length) throw new Error('Source image is empty');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wb-flux-'));
  const inputExt = sniffImage(imageBuffer) === 'image/jpeg' ? '.jpg' : '.png';
  const inputPath = path.join(dir, `input${inputExt}`);
  const outputPath = path.join(dir, 'output.png');
  try {
    await fs.promises.writeFile(inputPath, imageBuffer);
    const args = buildMfluxKontextArgs({
      imagePath: inputPath,
      outputPath,
      prompt,
      env,
    });
    await runMflux(args, { env });
    const buffer = await fs.promises.readFile(outputPath);
    if (!buffer.length) throw new Error('Local FLUX Kontext returned an empty image');
    return { buffer, mimeType: sniffImage(buffer) };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  DEFAULT_MODEL,
  resolveImageEditProvider,
  buildMfluxKontextArgs,
  editImageWithLocalFlux,
};
