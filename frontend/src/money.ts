const MAX_MINOR_DIGITS = 31;
const MAX_AMOUNT_KURUS = 10n ** BigInt(MAX_MINOR_DIGITS) - 1n;
const liraFormatter = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });

export class AmountInputError extends Error {
  constructor() {
    super('INVALID_TRY_AMOUNT');
    this.name = 'AmountInputError';
  }
}

/** Parse a TRY decimal string into the backend's exact integer kuruş string. */
export function tryAmountToKurus(value: string): string {
  const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (match === null) throw new AmountInputError();

  const lira = BigInt(match[1]!);
  const kurus = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  const total = lira * 100n + kurus;
  if (total <= 0n || total > MAX_AMOUNT_KURUS) throw new AmountInputError();
  return total.toString();
}

/** Format the backend's positive integer kuruş string without floating-point conversion. */
export function formatTryAmount(amountKurus: string): string {
  if (!/^[1-9]\d{0,30}$/.test(amountKurus)) throw new TypeError('Invalid backend amount');
  const amount = BigInt(amountKurus);
  const lira = amount / 100n;
  const kurus = (amount % 100n).toString().padStart(2, '0');
  return `${liraFormatter.format(lira)},${kurus} TRY`;
}
