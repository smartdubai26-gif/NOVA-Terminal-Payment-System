import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { encryptHotWalletPrivateKey } from './cryptoKey';

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    const plainKey =
      process.env.PLAIN_HOT_WALLET_PRIVATE_KEY ||
      (await rl.question('Enter 64-hex TRON hot wallet private key: '));
    const decryptionSecret =
      process.env.HOT_WALLET_DECRYPTION_KEY ||
      (await rl.question('Enter decryption passphrase (min 16 chars): '));

    const envelope = encryptHotWalletPrivateKey(plainKey, decryptionSecret);
    console.log('\nEncrypted envelope generated (safe to store in .env):');
    console.log(`HOT_WALLET_PRIVATE_KEY_ENCRYPTED="${envelope}"`);
    console.log(
      'Remove plaintext HOT_WALLET_PRIVATE_KEY from production .env once verified.'
    );
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Encryption failed.';
  console.error('[ENCRYPT KEY ERROR]', message);
  process.exit(1);
});
