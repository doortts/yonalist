import unicodeLetter from "@unicode/unicode-17.0.0/General_Category/Letter/regex.js";
import unicodeMark from "@unicode/unicode-17.0.0/General_Category/Mark/regex.js";
import unicodeNumber from "@unicode/unicode-17.0.0/General_Category/Number/regex.js";

export function isUnicodeLetterOrNumber(character: string): boolean {
  return unicodeLetter.test(character) || unicodeNumber.test(character);
}

export function isUnicodeMark(character: string): boolean {
  return unicodeMark.test(character);
}

export function isUnicodeWordCharacter(character: string): boolean {
  return character === "_" || isUnicodeLetterOrNumber(character) || isUnicodeMark(character);
}
