/**
 * How the loan file prints its numbers.
 *
 * Locale is pinned to `en-US` rather than left to the browser. A server
 * component and a browser that disagree about a thousands separator is a
 * hydration mismatch, and the value on a projector should be the value the
 * presenter rehearsed with.
 *
 * Every one of these takes `number | string | undefined`, because a field that
 * crossed `/post` may hold a mask rather than a value (act 3) and a mask is text
 * whatever the field used to be. A string is printed exactly as it was handed
 * over: the redaction is information, and formatting it away would hide the one
 * thing act 3 exists to show.
 */

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const plain = new Intl.NumberFormat("en-US");

/** `95000` → `$95,000`. A string passes through untouched. */
export function dollars(value: number | string | undefined): string {
  if (typeof value === "number") return money.format(value);
  return value ?? "—";
}

/** `712` → `712`, `2340000` → `2,340,000`. A string passes through untouched. */
export function count(value: number | string | undefined): string {
  if (typeof value === "number") return plain.format(value);
  return value ?? "—";
}

/** Whatever is there, or an em dash. Never an empty cell — a blank reads as a bug. */
export function text(value: string | undefined): string {
  return value === undefined || value.trim() === "" ? "—" : value;
}

/**
 * The status a loan file is in, normalised for the attribute the stylesheet
 * keys on — and only when it is one this screen knows.
 *
 * An unrecognised status is styled as plain chrome rather than guessed at. The
 * loan book is free to grow a state this UI has never heard of, and a
 * `data-status` the stylesheet has no rule for is a neutral box rather than a
 * wrong colour.
 */
export function statusKey(value: string | undefined): string | undefined {
  const normalised = value?.trim().toLowerCase();
  return normalised === "pending" || normalised === "approved" || normalised === "denied"
    ? normalised
    : undefined;
}
