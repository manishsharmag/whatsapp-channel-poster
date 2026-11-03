/**
 * Builds the JavaScript bundle that ships inside the APK.
 *
 *   node android/tools/bundle.mjs            full app (src, node_modules, banks)
 *   node android/tools/bundle.mjs --clean    full app without the owner's channels/token
 *   node android/tools/bundle.mjs --minimal  shell test only
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const androidDir = path.join(root, 'android');
const staging = path.join(androidDir, 'build', 'app-staging');
const assets = path.join(androidDir, 'app', 'src', 'main', 'assets');
const minimal = process.argv.includes('--minimal');
const clean = process.argv.includes('--clean');

const copyDir = (from, to) => {
  fs.cpSync(path.join(root, from), path.join(staging, to), {
    recursive: true,
    dereference: true,
    filter: (src) => !src.includes(`${path.sep}.git${path.sep}`),
  });
};

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.mkdirSync(assets, { recursive: true });

fs.mkdirSync(path.join(staging, 'android'), { recursive: true });
fs.copyFileSync(
  path.join(androidDir, 'node', 'start.js'),
  path.join(staging, 'android', 'start.js'),
);
// The whole app is ESM ("type": "module"); without this Node treats every .js
// file as CommonJS.
fs.copyFileSync(path.join(root, 'package.json'), path.join(staging, 'package.json'));
console.log('  android/start.js');
console.log('  package.json');

if (!minimal) {
  copyDir('src', 'src');
  console.log('  src/');

  copyDir('node_modules', 'node_modules');
  console.log('  node_modules/');

  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const bankDir = path.join(staging, 'banks');
  fs.mkdirSync(bankDir, { recursive: true });
  const bundled = [];
  for (const bankPath of cfg.bankPaths ?? []) {
    if (!fs.existsSync(bankPath)) {
      console.log(`  ! missing bank: ${bankPath}`);
      continue;
    }
    const name = path.basename(bankPath);
    fs.copyFileSync(bankPath, path.join(bankDir, name));
    bundled.push(name);
    console.log(`  banks/${name}`);
  }

  // Paths are rewritten again on the device; this keeps the bundle readable.
  const forDevice = {
    ...cfg,
    bankPaths: bundled.map((name) => `banks/${name}`),
    // Pairing is the only workable login on a phone: you cannot scan a QR code
    // that is displayed on the same screen.
    loginMethod: 'pairing',
    phoneNumber: '',
  };

  if (clean) {
    // A shared APK must not carry the owner's channels, bot token or progress.
    forDevice.channels = [];
    forDevice.channelJid = '';
    forDevice.telegram = {
      ...(cfg.telegram ?? {}),
      enabled: false,
      botToken: '',
      chats: [],
    };
    forDevice.selection = { modules: [], subtopics: [], mode: 'sequence', quotas: [], quotaOrder: 'grouped' };
    forDevice.batch = { ...cfg.batch, size: 50, gapSeconds: 20 };
    // Growth is the riskiest feature; a shared APK starts with it fully off.
    forDevice.growth = {
      enabled: false,
      dryRun: true,
      channelLink: '',
      autoJoin: false,
      autoShare: false,
    };
    forDevice.forwarder = {
      ...(cfg.forwarder ?? {}),
      enabled: false,
      sources: [],
      targets: [],
      dryRun: false,
    };
  }

  fs.writeFileSync(path.join(staging, 'config.json'), `${JSON.stringify(forDevice, null, 2)}\n`);
  console.log(`  config.json${clean ? ' (clean: no channels, no token)' : ''}`);
}

const total = (dir) => {
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else bytes += fs.statSync(full).size;
    }
  };
  walk(dir);
  return bytes;
};
console.log(`Staged ${(total(staging) / 1048576).toFixed(1)} MB in ${staging}`);
