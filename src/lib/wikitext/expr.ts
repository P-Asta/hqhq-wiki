/**
 * `{{#expr:}}` — numeric expression evaluator over IEEE doubles.
 *
 * Normative source: docs/engine/wikitext-spec.md §9.3 (token set, the full
 * precedence table, result formatting, and the exact error strings).
 *
 * Implemented as a precedence-climbing recursive-descent parser rather than a
 * shunting-yard stack, because §9.3's precedence table mixes unary functions,
 * unary sign, the `e` scientific operator and `round` at distinct levels; one
 * grammar rule per level is the direct, checkable transcription of the table.
 *
 * Precedence (highest → lowest), all binary operators left-associative:
 *   1 `( )` · 2 unary functions · 3 unary `-`/`+` · 4 `e` · 5 `^`
 *   6 `*` `/` `div` `mod` · 7 `+` `-` · 8 `round`
 *   9 `=` `!=` `<>` `<` `>` `<=` `>=` · 10 `and` · 11 `or`
 *
 * Note on `e`: §9.3 lists it both as a constant and as the scientific
 * operator. The two roles occupy disjoint parser positions, so both are
 * honoured — `e` in operand position is Euler's number, `e` in operator
 * position is `× 10^n` (`2e3` = 2000). MediaWiki implements only the
 * operator; this is a strict superset and never changes the value of an
 * expression MediaWiki accepts.
 */

/** Thrown for every §9.3 error; `message` is the bare text (no wrapper). */
export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

/** `<strong class="error">Expression error: {message}.</strong>` (§9.3). */
export function exprErrorHtml(message: string): string {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<strong class="error">Expression error: ${escaped}.</strong>`;
}

/* ------------------------------------------------------------------ */
/* Lexer                                                               */
/* ------------------------------------------------------------------ */

type Token =
  | { kind: "num"; value: number }
  | { kind: "word"; value: string }
  | { kind: "punct"; value: string };

/** Words §9.3 recognizes; anything else is `Unrecognized word "x"`. */
const UNARY_FUNCTIONS = new Set([
  "not",
  "ceil",
  "trunc",
  "floor",
  "abs",
  "sqrt",
  "exp",
  "ln",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
]);
const WORD_OPERATORS = new Set(["div", "mod", "round", "and", "or", "e"]);
const CONSTANTS = new Set(["pi", "e"]);

const NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const WORD_RE = /^[A-Za-z]+/;
const PUNCT2 = new Set(["<=", ">=", "<>", "!="]);
const PUNCT1 = new Set(["+", "-", "*", "/", "^", "(", ")", "=", "<", ">"]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let rest = source;
  while (rest.length > 0) {
    const ws = /^\s+/.exec(rest);
    if (ws) {
      rest = rest.slice(ws[0].length);
      continue;
    }
    const num = NUMBER_RE.exec(rest);
    if (num) {
      tokens.push({ kind: "num", value: Number(num[0]) });
      rest = rest.slice(num[0].length);
      continue;
    }
    const word = WORD_RE.exec(rest);
    if (word) {
      const value = word[0].toLowerCase();
      if (
        !UNARY_FUNCTIONS.has(value) &&
        !WORD_OPERATORS.has(value) &&
        !CONSTANTS.has(value)
      ) {
        throw new ExprError(`Unrecognized word "${value}"`);
      }
      tokens.push({ kind: "word", value });
      rest = rest.slice(word[0].length);
      continue;
    }
    const two = rest.slice(0, 2);
    if (PUNCT2.has(two)) {
      tokens.push({ kind: "punct", value: two });
      rest = rest.slice(2);
      continue;
    }
    const one = rest[0];
    if (PUNCT1.has(one)) {
      tokens.push({ kind: "punct", value: one });
      rest = rest.slice(1);
      continue;
    }
    throw new ExprError(`Unrecognized punctuation character "${one}"`);
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

const bool = (b: boolean): number => (b ? 1 : 0);

function applyFunction(name: string, x: number): number {
  switch (name) {
    case "not":
      return bool(x === 0);
    case "ceil":
      return Math.ceil(x);
    case "trunc":
      return Math.trunc(x);
    case "floor":
      return Math.floor(x);
    case "abs":
      return Math.abs(x);
    case "sqrt":
      if (x < 0) throw new ExprError("Result of sqrt is not a number");
      return Math.sqrt(x);
    case "exp":
      return Math.exp(x);
    case "ln":
      if (x <= 0) throw new ExprError("Invalid argument for ln");
      return Math.log(x);
    case "sin":
      return Math.sin(x);
    case "cos":
      return Math.cos(x);
    case "tan":
      return Math.tan(x);
    case "asin":
      if (x < -1 || x > 1) throw new ExprError("Invalid argument for asin");
      return Math.asin(x);
    case "acos":
      if (x < -1 || x > 1) throw new ExprError("Invalid argument for acos");
      return Math.acos(x);
    default:
      return Math.atan(x);
  }
}

/** `a round n`: half-away-from-zero to `n` decimal places (negative = tens…). */
function exprRound(a: number, n: number): number {
  const digits = Math.trunc(n);
  const factor = Math.pow(10, digits);
  const scaled = a * factor;
  if (!Number.isFinite(scaled)) return a;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return rounded / factor;
}

function exprPow(a: number, b: number): number {
  if (a < 0 && !Number.isInteger(b)) {
    throw new ExprError("Result of ^ is not a number");
  }
  const result = Math.pow(a, b);
  if (Number.isNaN(result)) throw new ExprError("Result of ^ is not a number");
  return result;
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

class ExprParser {
  private pos = 0;
  private depth = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): number {
    const value = this.parseOr();
    if (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      if (token.kind === "punct" && token.value === ")") {
        throw new ExprError("Unexpected closing bracket");
      }
      throw new ExprError("Unexpected number");
    }
    return value;
  }

  private peek(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
  }

  private matchWord(...words: string[]): string | null {
    const token = this.peek();
    if (token && token.kind === "word" && words.includes(token.value)) {
      this.pos += 1;
      return token.value;
    }
    return null;
  }

  private matchPunct(...values: string[]): string | null {
    const token = this.peek();
    if (token && token.kind === "punct" && values.includes(token.value)) {
      this.pos += 1;
      return token.value;
    }
    return null;
  }

  /** Right-hand operand of `op`; an absent one is a §9.3 `Missing operand`. */
  private operand(op: string, parse: () => number): number {
    if (this.pos >= this.tokens.length) {
      throw new ExprError(`Missing operand for ${op}`);
    }
    return parse.call(this);
  }

  private parseOr(): number {
    let left = this.parseAnd();
    for (;;) {
      const op = this.matchWord("or");
      if (op === null) return left;
      const right = this.operand(op, this.parseAnd);
      left = bool(left !== 0 || right !== 0);
    }
  }

  private parseAnd(): number {
    let left = this.parseComparison();
    for (;;) {
      const op = this.matchWord("and");
      if (op === null) return left;
      const right = this.operand(op, this.parseComparison);
      left = bool(left !== 0 && right !== 0);
    }
  }

  private parseComparison(): number {
    let left = this.parseRound();
    for (;;) {
      const op = this.matchPunct("=", "!=", "<>", "<", ">", "<=", ">=");
      if (op === null) return left;
      const right = this.operand(op, this.parseRound);
      switch (op) {
        case "=":
          left = bool(left === right);
          break;
        case "!=":
        case "<>":
          left = bool(left !== right);
          break;
        case "<":
          left = bool(left < right);
          break;
        case ">":
          left = bool(left > right);
          break;
        case "<=":
          left = bool(left <= right);
          break;
        default:
          left = bool(left >= right);
          break;
      }
    }
  }

  private parseRound(): number {
    let left = this.parseAdditive();
    for (;;) {
      const op = this.matchWord("round");
      if (op === null) return left;
      const right = this.operand(op, this.parseAdditive);
      left = exprRound(left, right);
    }
  }

  private parseAdditive(): number {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = this.matchPunct("+", "-");
      if (op === null) return left;
      const right = this.operand(op, this.parseMultiplicative);
      left = op === "+" ? left + right : left - right;
    }
  }

  private parseMultiplicative(): number {
    let left = this.parsePower();
    for (;;) {
      const op = this.matchPunct("*", "/") ?? this.matchWord("div", "mod");
      if (op === null) return left;
      const right = this.operand(op, this.parsePower);
      if (op === "*") {
        left = left * right;
        continue;
      }
      if (op === "mod") {
        // C-style remainder: truncate both toward zero, sign follows dividend.
        const divisor = Math.trunc(right);
        if (divisor === 0) throw new ExprError("Division by zero");
        left = Math.trunc(left) % divisor;
        continue;
      }
      // "/" and "div" are both real division (§9.3 level 6).
      if (right === 0) throw new ExprError("Division by zero");
      left = left / right;
    }
  }

  private parsePower(): number {
    let left = this.parseScientific();
    for (;;) {
      const op = this.matchPunct("^");
      if (op === null) return left;
      const right = this.operand(op, this.parseScientific);
      left = exprPow(left, right);
    }
  }

  /** `a e b` = a × 10^b (§9.3 level 4). */
  private parseScientific(): number {
    let left = this.parseUnary();
    for (;;) {
      const op = this.matchWord("e");
      if (op === null) return left;
      const right = this.operand(op, this.parseUnary);
      left = left * Math.pow(10, right);
    }
  }

  private parseUnary(): number {
    const sign = this.matchPunct("-", "+");
    if (sign !== null) {
      const value = this.operand(sign, this.parseUnary);
      return sign === "-" ? -value : value;
    }
    const token = this.peek();
    if (token !== null && token.kind === "word" && UNARY_FUNCTIONS.has(token.value)) {
      this.pos += 1;
      const value = this.operand(token.value, this.parseUnary);
      return applyFunction(token.value, value);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.peek();
    if (token === null) {
      throw new ExprError(
        this.depth > 0 ? "Unclosed bracket" : "Missing operand for expression",
      );
    }
    if (token.kind === "num") {
      this.pos += 1;
      return token.value;
    }
    if (token.kind === "word") {
      // Unary functions were consumed above, so only constants can start an
      // operand here; a word operator in operand position lacks its left side.
      if (!CONSTANTS.has(token.value)) {
        throw new ExprError(`Missing operand for ${token.value}`);
      }
      this.pos += 1;
      return token.value === "pi" ? Math.PI : Math.E;
    }
    if (token.value === "(") {
      this.pos += 1;
      this.depth += 1;
      const value = this.parseOr();
      if (this.matchPunct(")") === null) throw new ExprError("Unclosed bracket");
      this.depth -= 1;
      return value;
    }
    if (token.value === ")") throw new ExprError("Unexpected closing bracket");
    throw new ExprError(`Missing operand for ${token.value}`);
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Evaluate an `#expr` source string. Returns `null` for an empty/whitespace
 * expression (MediaWiki renders nothing there). Throws {@link ExprError}.
 */
export function evaluateExpr(source: string): number | null {
  const tokens = tokenize(source);
  if (tokens.length === 0) return null;
  return new ExprParser(tokens).parse();
}

/**
 * §9.3 result formatting: `-0` → `0`; integral |x| < 1e16 without a decimal
 * point; otherwise up to 14 significant digits with no trailing zeros.
 */
export function formatExprNumber(value: number): string {
  if (Number.isNaN(value)) return "NAN";
  if (value === Number.POSITIVE_INFINITY) return "INF";
  if (value === Number.NEGATIVE_INFINITY) return "-INF";
  if (Number.isInteger(value) && Math.abs(value) < 1e16) {
    return Object.is(value, -0) ? "0" : String(value);
  }
  // toPrecision(14) then a round-trip through Number() drops trailing zeros.
  const rounded = Number(value.toPrecision(14));
  if (rounded === 0) return "0";
  return String(rounded);
}

/** Evaluate + format, returning the §9.3 error HTML instead of throwing. */
export function evaluateExprToString(source: string): string {
  try {
    const value = evaluateExpr(source);
    return value === null ? "" : formatExprNumber(value);
  } catch (error) {
    if (error instanceof ExprError) return exprErrorHtml(error.message);
    throw error;
  }
}
