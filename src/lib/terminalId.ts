import type { AssetSymbol, NetworkId } from '../types/ntps';

/**
 * Crockford Base32 encoding alphabet (32 characters: excludes I, L, O, U)
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Crockford Mod-37 check symbol alphabet (37 characters)
 */
export const CROCKFORD_CHECK_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U';

export interface TerminalIdValidationResult {
  isValid: boolean;
  isEmpty: boolean;
  normalized: string;
  rawCleaned: string;
  type: 'master' | 'sub' | null;
  masterBase: string | null;
  payload7: string | null;
  checkCharActual: string | null;
  checkCharExpected: string | null;
  subSuffix: string | null;
  corrections: string[];
  error: string | null;
}

/**
 * Computes Crockford Mod-37 check value (0..36) over a Base32 string.
 */
export function computeCrockfordMod37Index(base32Payload: string): number {
  let acc = 0;
  for (let i = 0; i < base32Payload.length; i++) {
    const val = CROCKFORD_ALPHABET.indexOf(base32Payload[i]);
    if (val === -1) return -1;
    acc = (acc * 32 + val) % 37;
  }
  return acc;
}

/**
 * Builds a guaranteed-valid NT-OMEGA-XXXX-XXXX Master Terminal ID from a 7-char Crockford seed.
 * Adjusts the 7th char if mod-37 lands in the 32..36 special symbol range so all IDs remain strictly alphanumeric.
 */
export function buildMasterTerminalIdFromSeed(seed7: string): string {
  const clean = seed7
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
    .slice(0, 7)
    .padEnd(7, '0');

  const prefix6 = clean.slice(0, 6);
  let lastIdx = CROCKFORD_ALPHABET.indexOf(clean[6]);
  if (lastIdx === -1) lastIdx = 0;

  for (let offset = 0; offset < 32; offset++) {
    const candidate7 = prefix6 + CROCKFORD_ALPHABET[(lastIdx + offset) % 32];
    const mod37 = computeCrockfordMod37Index(candidate7);
    if (mod37 >= 0 && mod37 < 32) {
      const checkChar = CROCKFORD_ALPHABET[mod37];
      const full8 = candidate7 + checkChar;
      return `NT-OMEGA-${full8.slice(0, 4)}-${full8.slice(4, 8)}`;
    }
  }
  // Fallback (mathematically unreachable since 32 consecutive increments cover mod 37)
  return 'NT-OMEGA-7K9P-3M27';
}

/**
 * Generates a cryptographically random, Crockford Mod-37 valid Master Terminal ID.
 */
export function generateMasterTerminalId(): string {
  const bytes = new Uint8Array(7);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 7; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let seed7 = '';
  for (let i = 0; i < 7; i++) {
    seed7 += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return buildMasterTerminalIdFromSeed(seed7);
}

/**
 * Formats a Sub-Terminal ID from a valid Master Terminal ID and 1-based index.
 */
export function generateSubTerminalId(masterTerminalId: string, index: number): string {
  const validation = validateTerminalId(masterTerminalId);
  const base = validation.masterBase ?? masterTerminalId;
  const suffix = `S${String(Math.max(1, index)).padStart(2, '0')}`;
  return `${base}-${suffix}`;
}

/**
 * Normalizes user input into canonical NT-OMEGA-XXXX-XXXX(-SXX) form.
 * - Strips spaces
 * - Auto-uppercases
 * - Fixes prefix typos (0 -> O in OMEGA)
 * - Fixes Crockford Base32 payload typos (O -> 0, I/L -> 1)
 */
export function normalizeTerminalIdInput(raw: string): {
  normalized: string;
  corrections: string[];
} {
  const corrections: string[] = [];
  if (!raw) return { normalized: '', corrections };

  let s = raw.replace(/\s+/g, '').toUpperCase();
  if (s !== raw.trim().toUpperCase()) {
    corrections.push('Stripped whitespace');
  }

  // Normalize prefix if user starts typing NT-0MEGA or NTOMEGA
  if (s.startsWith('NT0MEGA') || s.startsWith('NT-0MEGA')) {
    s = s.replace(/^NT-?0MEGA/, 'NT-OMEGA');
    corrections.push('0 → O in OMEGA prefix');
  } else if (s.startsWith('NTOMEGA')) {
    s = s.replace(/^NTOMEGA/, 'NT-OMEGA');
  }

  // Strip prefix for body normalization if present
  let prefix = '';
  let remainder = s;
  if (remainder.startsWith('NT-OMEGA-')) {
    prefix = 'NT-OMEGA-';
    remainder = remainder.slice('NT-OMEGA-'.length);
  } else if (remainder.startsWith('NT-OMEGA')) {
    prefix = 'NT-OMEGA-';
    remainder = remainder.slice('NT-OMEGA'.length).replace(/^-+/, '');
  }

  // Remove hyphens in remainder to inspect payload + optional sub suffix
  const compact = remainder.replace(/-/g, '');

  // Detect sub suffix at end (e.g., S01, S12) when length > 8
  let bodyPart = compact;
  let subPart = '';
  if (compact.length > 8) {
    bodyPart = compact.slice(0, 8);
    subPart = compact.slice(8);
  }

  // Apply Crockford typo normalization on Base32 body (O -> 0, I/L -> 1)
  let fixedBody = '';
  let fixedO = false;
  let fixedIL = false;
  for (const ch of bodyPart) {
    if (ch === 'O') {
      fixedBody += '0';
      fixedO = true;
    } else if (ch === 'I' || ch === 'L') {
      fixedBody += '1';
      fixedIL = true;
    } else {
      fixedBody += ch;
    }
  }
  if (fixedO) corrections.push('Normalized O → 0 (Crockford)');
  if (fixedIL) corrections.push('Normalized I/L → 1 (Crockford)');

  // Reconstruct canonical hyphenation
  if (!prefix) {
    return { normalized: s, corrections };
  }

  let formatted = prefix;
  if (fixedBody.length <= 4) {
    formatted += fixedBody;
  } else {
    formatted += `${fixedBody.slice(0, 4)}-${fixedBody.slice(4, 8)}`;
  }

  if (subPart) {
    // Normalize sub-terminal digits (O->0, I/L->1 after S)
    const cleanSub = subPart.startsWith('S')
      ? 'S' + subPart.slice(1).replace(/O/g, '0').replace(/[IL]/g, '1')
      : subPart;
    formatted += `-${cleanSub}`;
  }

  return { normalized: formatted, corrections };
}

/**
 * Validates a Terminal ID against NTPS format and Crockford Base32 Mod-37 checksum.
 */
export function validateTerminalId(rawInput: string): TerminalIdValidationResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      isValid: false,
      isEmpty: true,
      normalized: '',
      rawCleaned: '',
      type: null,
      masterBase: null,
      payload7: null,
      checkCharActual: null,
      checkCharExpected: null,
      subSuffix: null,
      corrections: [],
      error: null,
    };
  }

  const { normalized, corrections } = normalizeTerminalIdInput(trimmed);

  // Match Master: NT-OMEGA-XXXX-XXXX or Sub: NT-OMEGA-XXXX-XXXX-S01
  const pattern = /^NT-OMEGA-([0-9A-Z]{4})-([0-9A-Z]{4})(?:-(S\d{2,3}))?$/;
  const match = normalized.match(pattern);

  if (!match) {
    return {
      isValid: false,
      isEmpty: false,
      normalized,
      rawCleaned: normalized,
      type: null,
      masterBase: null,
      payload7: null,
      checkCharActual: null,
      checkCharExpected: null,
      subSuffix: null,
      corrections,
      error: 'Expected format NT-OMEGA-XXXX-XXXX or NT-OMEGA-XXXX-XXXX-S01',
    };
  }

  const block1 = match[1];
  const block2 = match[2];
  const subSuffix = match[3] ?? null;
  const full8 = block1 + block2;
  const payload7 = full8.slice(0, 7);
  const checkCharActual = full8[7];

  for (const ch of payload7) {
    if (!CROCKFORD_ALPHABET.includes(ch)) {
      return {
        isValid: false,
        isEmpty: false,
        normalized,
        rawCleaned: normalized,
        type: subSuffix ? 'sub' : 'master',
        masterBase: `NT-OMEGA-${block1}-${block2}`,
        payload7,
        checkCharActual,
        checkCharExpected: null,
        subSuffix,
        corrections,
        error: `Character "${ch}" is excluded from Crockford Base32`,
      };
    }
  }

  const mod37 = computeCrockfordMod37Index(payload7);
  const checkCharExpected = CROCKFORD_CHECK_ALPHABET[mod37];
  const isValid = mod37 >= 0 && checkCharActual === checkCharExpected;

  return {
    isValid,
    isEmpty: false,
    normalized,
    rawCleaned: normalized,
    type: subSuffix ? 'sub' : 'master',
    masterBase: `NT-OMEGA-${block1}-${block2}`,
    payload7,
    checkCharActual,
    checkCharExpected,
    subSuffix,
    corrections,
    error: isValid
      ? null
      : `Mod-37 checksum mismatch: expected "${checkCharExpected}", got "${checkCharActual}"`,
  };
}

/**
 * Generates a deterministic deposit address linked to a Terminal ID + Asset + Network.
 */
export function deriveDepositAddress(
  terminalId: string,
  asset: AssetSymbol,
  network: NetworkId
): string {
  // Simple deterministic FNV-1a style hash expansion for consistent realistic addresses
  const seed = `${terminalId}::${asset}::${network}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < seed.length; i++) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= seed.charCodeAt(i) + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }

  const hexChars = '0123456789abcdef';
  const b58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bech32Chars = '023456789acdefghjklmnpqrstuvwxyz';

  const makeStream = (alphabet: string, len: number): string => {
    let out = '';
    let state = (h1 ^ h2) >>> 0;
    for (let i = 0; i < len; i++) {
      state = (Math.imul(state, 1664525) + 1013904223 + i * 31) >>> 0;
      out += alphabet[state % alphabet.length];
    }
    return out;
  };

  if (network === 'TRC20') {
    return 'T' + makeStream(b58Chars, 33);
  }
  if (network === 'BTC' || asset === 'BTC') {
    return 'bc1q' + makeStream(bech32Chars, 38);
  }
  return '0x' + makeStream(hexChars, 40);
}

/**
 * Generates a realistic 64-char hex transaction hash or internal NTPS settlement hash.
 */
export function generateTxHash(prefix = '0x'): string {
  const hex = '0123456789abcdef';
  let out = prefix;
  for (let i = 0; i < 64; i++) {
    out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}
