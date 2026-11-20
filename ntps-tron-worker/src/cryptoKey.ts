import crypto from 'node:crypto';

const ENVELOPE_PREFIX = 'ntps:v1:aes256gcm:';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

export interface HotWalletKeyResolution {
  privateKey: string;
  source: 'encrypted' | 'plaintext_fallback';
}

function normalizeTronPrivateKey(rawKey: string): string {
  const trimmed = rawKey.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      'Invalid TRON hot wallet private key format (expected 64 hexadecimal characters).'
    );
  }
  return trimmed;
}

function deriveAesKey(decryptionSecret: string, salt: Buffer): Buffer {
  if (!decryptionSecret || decryptionSecret.trim().length < 16) {
    throw new Error(
      'HOT_WALLET_DECRYPTION_KEY must be at least 16 characters (32+ random characters recommended).'
    );
  }
  return crypto.scryptSync(decryptionSecret, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

/**
 * Encrypts a TRON private key using AES-256-GCM with a random salt + IV
 * and scrypt key derivation for safe storage at rest in worker environment variables.
 */
export function encryptHotWalletPrivateKey(
  plainPrivateKey: string,
  decryptionSecret: string
): string {
  const normalizedKey = normalizeTronPrivateKey(plainPrivateKey);
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const aesKey = deriveAesKey(decryptionSecret, salt);

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(normalizedKey, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      'ntps',
      'v1',
      'aes256gcm',
      salt.toString('hex'),
      iv.toString('hex'),
      authTag.toString('hex'),
      ciphertext.toString('hex'),
    ].join(':');
  } finally {
    aesKey.fill(0);
  }
}

/**
 * Decrypts an `ntps:v1:aes256gcm:<salt>:<iv>:<tag>:<ciphertext>` envelope.
 * Never logs or includes secret material in thrown errors.
 */
export function decryptHotWalletPrivateKey(
  encryptedPayload: string,
  decryptionSecret: string
): string {
  const trimmed = encryptedPayload.trim();
  if (!trimmed.startsWith(ENVELOPE_PREFIX)) {
    throw new Error(
      'Unsupported HOT_WALLET_PRIVATE_KEY_ENCRYPTED format (expected ntps:v1:aes256gcm:<salt>:<iv>:<tag>:<ciphertext>).'
    );
  }

  const parts = trimmed.split(':');
  if (parts.length !== 7) {
    throw new Error('Malformed HOT_WALLET_PRIVATE_KEY_ENCRYPTED payload.');
  }

  const [, , , saltHex, ivHex, tagHex, cipherHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(cipherHex, 'hex');

  if (
    salt.length !== SALT_LEN ||
    iv.length !== IV_LEN ||
    authTag.length !== AUTH_TAG_LEN ||
    ciphertext.length === 0
  ) {
    throw new Error('Invalid AES-256-GCM parameter lengths in encrypted key payload.');
  }

  const aesKey = deriveAesKey(decryptionSecret, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');

    return normalizeTronPrivateKey(decrypted);
  } catch {
    throw new Error(
      'Failed to decrypt HOT_WALLET_PRIVATE_KEY_ENCRYPTED. Verify HOT_WALLET_DECRYPTION_KEY.'
    );
  } finally {
    aesKey.fill(0);
  }
}

/**
 * Resolves the hot wallet private key from encrypted environment variables first,
 * falling back to plaintext `HOT_WALLET_PRIVATE_KEY` only for migration/local dev.
 * Never logs any key material.
 */
export function resolveHotWalletPrivateKey(
  env: NodeJS.ProcessEnv = process.env
): HotWalletKeyResolution {
  const encrypted = env.HOT_WALLET_PRIVATE_KEY_ENCRYPTED?.trim();
  const decryptionKey = env.HOT_WALLET_DECRYPTION_KEY?.trim();
  const plaintext = env.HOT_WALLET_PRIVATE_KEY?.trim();

  if (encrypted) {
    if (!decryptionKey) {
      throw new Error(
        'HOT_WALLET_PRIVATE_KEY_ENCRYPTED is set, but HOT_WALLET_DECRYPTION_KEY is missing.'
      );
    }
    const privateKey = decryptHotWalletPrivateKey(encrypted, decryptionKey);
    console.log(
      '[SECURITY] TRON hot wallet key decrypted via AES-256-GCM envelope.'
    );
    return { privateKey, source: 'encrypted' };
  }

  if (plaintext) {
    const privateKey = normalizeTronPrivateKey(plaintext);
    console.warn(
      '[SECURITY WARNING] Using unencrypted HOT_WALLET_PRIVATE_KEY fallback. Migrate to HOT_WALLET_PRIVATE_KEY_ENCRYPTED + HOT_WALLET_DECRYPTION_KEY for production.'
    );
    return { privateKey, source: 'plaintext_fallback' };
  }

  throw new Error(
    'Missing hot wallet key: configure HOT_WALLET_PRIVATE_KEY_ENCRYPTED + HOT_WALLET_DECRYPTION_KEY (recommended) or HOT_WALLET_PRIVATE_KEY (dev fallback).'
  );
}
