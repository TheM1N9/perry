/**
 * Prices as shops write them, for price watches (web.ts). Pure functions with
 * no server imports: the watch_page tool and the Work page's form use them too.
 *
 * A price is a number with a currency beside it, before or after: "$199",
 * "₹1,23,456", "Rs. 25,000", "€ 1.299,00", "1 299,00 €", "£49.99", "199 USD".
 * A bare number is not a price, so a page's other figures never count.
 */

export type Price = { amount: number; currency: string };

/** Symbols and words shops write, to ISO 4217 codes. Longer ones first, so "US$" wins over "$". */
const MARKS: [string, string][] = [
  ["US$", "USD"], ["A$", "AUD"], ["AU$", "AUD"], ["C$", "CAD"], ["CA$", "CAD"], ["S$", "SGD"], ["NZ$", "NZD"], ["HK$", "HKD"], ["R$", "BRL"],
  ["Rs.", "INR"], ["Rs", "INR"], ["₹", "INR"], ["€", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["₩", "KRW"], ["₽", "RUB"], ["₺", "TRY"], ["₫", "VND"], ["฿", "THB"], ["₱", "PHP"], ["zł", "PLN"],
  ["$", "USD"],
];
const CODES = ["USD", "INR", "EUR", "GBP", "JPY", "AUD", "CAD", "SGD", "NZD", "HKD", "CHF", "AED", "SAR", "CNY", "KRW", "BRL", "ZAR", "SEK", "NOK", "DKK", "PLN", "MXN", "THB", "IDR", "MYR", "PHP", "VND", "TRY", "RUB"];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Not inside a word, so "hours 5" is not rupees.
const MARK = `(?<![A-Za-z])(?:${[...MARKS.map(([mark]) => escape(mark)), ...CODES.map((code) => `${code}\\b`)].join("|")})`;
// Digits grouped by commas or dots (Indian lakhs too), with maybe a decimal part;
// or plain digits. parseAmount sorts them out. Before a currency ("1 299,00 €"),
// spaces group thousands too; after one, a space ends the price ("$199 500 units").
const number = (spaces: string) => `\\d{1,3}(?:[,.]\\d{2,3}|[${spaces}]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?`;
const PRICE = new RegExp(`(?:(${MARK})\\s?(${number("\\u00a0\\u202f")}))|(?:(${number(" \\u00a0\\u202f")})\\s?(${MARK}))`, "g");

function currencyOf(mark: string): string {
  const upper = mark.toUpperCase();
  if (CODES.includes(upper)) return upper;
  return MARKS.find(([symbol]) => symbol.toUpperCase() === upper)?.[1] ?? "USD";
}

/**
 * "1,23,456.78" → 123456.78, "1.299,00" → 1299, "1 299,00" → 1299, "25.000" → 25000.
 * The last separator is the decimal point when one or two digits follow it;
 * every other separator groups thousands (or lakhs).
 */
export function parseAmount(raw: string): number | null {
  const text = raw.replace(/[\s  ]/g, "");
  const decimal = text.match(/[.,](\d{1,2})$/);
  const whole = (decimal ? text.slice(0, -decimal[0].length) : text).replace(/[,.]/g, "");
  if (!/^\d+$/.test(whole)) return null;
  const value = Number(decimal ? `${whole}.${decimal[1]}` : whole);
  return Number.isFinite(value) ? value : null;
}

/** Every price on the page, in the order it appears. */
export function findPrices(text: string): Price[] {
  const prices: Price[] = [];
  for (const match of text.matchAll(PRICE)) {
    const mark = match[1] ?? match[4];
    const amount = parseAmount(match[2] ?? match[3]);
    if (mark && amount !== null) prices.push({ amount, currency: currencyOf(mark) });
  }
  return prices;
}

/**
 * The price a watch goes below, as the owner wrote it: "₹25,000", "199 EUR",
 * or a bare "199", which takes any currency. Null when it is not a number.
 */
export function parseTarget(value: string): { amount: number; currency?: string } | null {
  const [price] = findPrices(value);
  if (price) return price;
  const amount = parseAmount(value.trim());
  return amount === null ? null : { amount };
}

/** The first price on the page in the currency wanted, or in any currency when none is. */
export function firstPrice(text: string, currency?: string): Price | null {
  return findPrices(text).find((price) => !currency || price.currency === currency) ?? null;
}

export function formatPrice(price: { amount: number; currency?: string }): string {
  if (!price.currency) return price.amount.toLocaleString("en");
  const locale = price.currency === "INR" ? "en-IN" : "en";
  return new Intl.NumberFormat(locale, { style: "currency", currency: price.currency, minimumFractionDigits: Number.isInteger(price.amount) ? 0 : 2, maximumFractionDigits: 2 }).format(price.amount);
}
