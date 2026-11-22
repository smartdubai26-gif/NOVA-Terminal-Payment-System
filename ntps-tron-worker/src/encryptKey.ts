import fs from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { encryptHotWalletPrivateKey } from './cryptoKey';

function parseKeyFileArg(argv: string[]): string | null {
  const idx = argv.indexOf('--key-file');
  if (idx === -1) return null;
  const target = argv[idx + 1];
  if (!target || target.startsWith('--')) {
    throw new Error('Usage: npm run encrypt-key -- [--key-file <path>]');
  }
  return target;
}

async function promptMasked(questionText: string): Promise<string> {
  if (!input.isTTY) {
    const rl = readline.createInterface({ input, terminal: false });
    try {
      const answer = await new Promise<string>((resolve) => {
        rl.once('line', (line) => resolve(line));
        rl.once('close', () => resolve(''));
      });
      return answer.trim();
    } finally {
      rl.close();
    }
  }

  let muted = false;
  const mutableOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        output.write(chunk, encoding);
      }
      callback();
    },
  });

  const rl = readline.createInterface({
    input,
    output: mutableOutput,
    terminal: true,
  });

  return new Promise<string>((resolve) => {
    output.write(questionText);
    muted = true;
    rl.question('', (answer) => {
      muted = false;
      output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readKeyFromFile(filePath: string): string {
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o077) !== 0) {
    console.warn(
      `[SECURITY WARNING] Key file "${filePath}" has permissive mode ${(stat.mode & 0o777).toString(8)}. Recommend chmod 600.`
    );
  }
  const buf = fs.readFileSync(filePath);
  try {
    return buf.toString('utf8').trim();
  } finally {
    buf.fill(0);
  }
}

async function main(): Promise<void> {
  if (process.env.PLAIN_HOT_WALLET_PRIVATE_KEY) {
    throw new Error(
      'PLAIN_HOT_WALLET_PRIVATE_KEY env var is disabled to prevent shell history and process environment leakage. Unset it and pass --key-file <path> or use the masked interactive prompt.'
    );
  }

  const keyFile = parseKeyFileArg(process.argv.slice(2));
  const plainKey = keyFile
    ? readKeyFromFile(keyFile)
    : await promptMasked('Enter 64-hex TRON hot wallet private key (input hidden): ');

  const decryptionSecret =
    process.env.HOT_WALLET_DECRYPTION_KEY?.trim() ||
    (await promptMasked('Enter decryption passphrase (min 32 chars, input hidden): '));

  const envelope = encryptHotWalletPrivateKey(plainKey, decryptionSecret);
  console.log('\nEncrypted ntps:v2 envelope generated (safe to store in .env):');
  console.log(`HOT_WALLET_PRIVATE_KEY_ENCRYPTED="${envelope}"`);
  console.log(
    'Remove plaintext HOT_WALLET_PRIVATE_KEY, any temporary key file, and ALLOW_PLAINTEXT_KEY from production once verified.'
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Encryption failed.';
  console.error('[ENCRYPT KEY ERROR]', message);
  process.exit(1);
});
