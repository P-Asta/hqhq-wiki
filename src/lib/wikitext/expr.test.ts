import { describe, expect, it } from "vitest";

import {
  ExprError,
  evaluateExpr,
  evaluateExprToString,
  exprErrorHtml,
  formatExprNumber,
} from "./expr";

/** Convenience: evaluate and format, throwing on error (spec §9.3). */
function ev(source: string): string {
  const value = evaluateExpr(source);
  return value === null ? "" : formatExprNumber(value);
}

function errorOf(source: string): string {
  try {
    evaluateExpr(source);
  } catch (error) {
    if (error instanceof ExprError) return error.message;
    throw error;
  }
  throw new Error(`expected ${source} to fail`);
}

describe("#expr — precedence table (spec §9.3)", () => {
  it("C-58: 2^3^2 is left-associative → 64", () => {
    expect(ev("2^3^2")).toBe("64");
  });

  it("§9.6-4: 2 + 3 * 4 = 14 and (2+3)*4 = 20", () => {
    expect(ev("2 + 3 * 4")).toBe("14");
    expect(ev("(2+3)*4")).toBe("20");
  });

  it("unary minus binds tighter than ^: -2^2 = 4", () => {
    expect(ev("-2^2")).toBe("4");
  });

  it("unary functions bind tighter than unary minus: -sqrt 4 = -2", () => {
    expect(ev("-sqrt 4")).toBe("-2");
  });

  it("e is the scientific operator at level 4: 2e3 = 2000, 1 e -3 = 0.001", () => {
    expect(ev("2e3")).toBe("2000");
    expect(ev("1 e -3")).toBe("0.001");
    expect(ev("1.5e3")).toBe("1500");
  });

  it("e binds tighter than ^: 2^1e1 = 1024", () => {
    expect(ev("2^1e1")).toBe("1024");
  });

  it("round sits below + -: 1 + 2.345 round 1 + 1 = 3.3", () => {
    // (1 + 2.345) round (1 + 1) → 3.35 rounded to 2 places.
    expect(ev("1 + 2.345 round 1 + 1")).toBe("3.35");
  });

  it("comparisons are below round and above and/or", () => {
    expect(ev("1 + 1 = 2")).toBe("1");
    expect(ev("1 = 2 or 3 = 3")).toBe("1");
    expect(ev("1 = 1 and 2 = 3")).toBe("0");
    expect(ev("2 <> 3")).toBe("1");
    expect(ev("2 != 2")).toBe("0");
    expect(ev("2 <= 2")).toBe("1");
  });

  it("pi and e are usable as constants in operand position", () => {
    expect(ev("pi round 5")).toBe("3.14159");
    expect(ev("e round 5")).toBe("2.71828");
  });
});

describe("#expr — arithmetic semantics (spec §9.3)", () => {
  it("§9.6-4: 7 mod -3 = 1 (operands truncated, sign follows dividend)", () => {
    expect(ev("7 mod -3")).toBe("1");
    expect(ev("-7 mod 3")).toBe("-1");
    expect(ev("7.9 mod 3")).toBe("1");
  });

  it("div is real division, like /", () => {
    expect(ev("7 div 2")).toBe("3.5");
    expect(ev("7 / 2")).toBe("3.5");
  });

  it("§9.6-4: 3.14159 round 2 = 3.14; rounding is half-away-from-zero", () => {
    expect(ev("3.14159 round 2")).toBe("3.14");
    expect(ev("2.5 round 0")).toBe("3");
    expect(ev("-2.5 round 0")).toBe("-3");
    expect(ev("1234 round -2")).toBe("1200");
  });

  it("0^0 = 1", () => {
    expect(ev("0^0")).toBe("1");
  });

  it("unary functions cover the §9.3 list", () => {
    expect(ev("not 0")).toBe("1");
    expect(ev("not 5")).toBe("0");
    expect(ev("ceil 1.2")).toBe("2");
    expect(ev("floor 1.8")).toBe("1");
    expect(ev("trunc -1.8")).toBe("-1");
    expect(ev("abs -3")).toBe("3");
    expect(ev("sqrt 16")).toBe("4");
    expect(ev("ln 1")).toBe("0");
    expect(ev("exp 0")).toBe("1");
    expect(ev("sin 0")).toBe("0");
    expect(ev("cos 0")).toBe("1");
    expect(ev("atan 0")).toBe("0");
  });
});

describe("#expr — result formatting (spec §9.3)", () => {
  it("-0 formats as 0", () => {
    expect(formatExprNumber(-0)).toBe("0");
    expect(ev("0 * -1")).toBe("0");
  });

  it("integers print without a decimal point", () => {
    expect(ev("4 / 2")).toBe("2");
    expect(ev("1e6")).toBe("1000000");
  });

  it("non-integers keep at most 14 significant digits, no trailing zeros", () => {
    expect(ev("1 / 3")).toBe("0.33333333333333");
    expect(ev("0.1 + 0.2")).toBe("0.3");
    expect(ev("2.500")).toBe("2.5");
  });

  it("infinities and NaN print like MediaWiki", () => {
    expect(formatExprNumber(Number.POSITIVE_INFINITY)).toBe("INF");
    expect(formatExprNumber(Number.NEGATIVE_INFINITY)).toBe("-INF");
    expect(formatExprNumber(Number.NaN)).toBe("NAN");
  });

  it("an empty expression yields nothing", () => {
    expect(evaluateExpr("   ")).toBeNull();
    expect(evaluateExprToString("")).toBe("");
  });
});

describe("#expr — error strings (spec §9.3)", () => {
  it("C-58: 1/0 → Division by zero", () => {
    expect(errorOf("1/0")).toBe("Division by zero");
    expect(evaluateExprToString("1/0")).toBe(
      '<strong class="error">Expression error: Division by zero.</strong>',
    );
  });

  it("x div 0 and x mod 0 are also Division by zero", () => {
    expect(errorOf("1 div 0")).toBe("Division by zero");
    expect(errorOf("1 mod 0")).toBe("Division by zero");
  });

  it('Unrecognized word "x"', () => {
    expect(errorOf("2 + foo")).toBe('Unrecognized word "foo"');
  });

  it('Unrecognized punctuation character "$"', () => {
    expect(errorOf("2 $ 3")).toBe('Unrecognized punctuation character "$"');
  });

  it("Unexpected closing bracket", () => {
    expect(errorOf("2)")).toBe("Unexpected closing bracket");
  });

  it("Unclosed bracket", () => {
    expect(errorOf("(2+3")).toBe("Unclosed bracket");
    expect(errorOf("(")).toBe("Unclosed bracket");
  });

  it("Missing operand for {op}", () => {
    expect(errorOf("2 +")).toBe("Missing operand for +");
    expect(errorOf("2 round")).toBe("Missing operand for round");
    expect(errorOf("2 e")).toBe("Missing operand for e");
    expect(errorOf("* 2")).toBe("Missing operand for *");
    expect(errorOf("sqrt")).toBe("Missing operand for sqrt");
  });

  it("negative base with a fractional exponent → Result of ^ is not a number", () => {
    expect(errorOf("-8 ^ 0.5")).toBe("Result of ^ is not a number");
  });

  it("sqrt of a negative is not a number", () => {
    expect(errorOf("sqrt -1")).toBe("Result of sqrt is not a number");
  });

  it("two adjacent operands are rejected", () => {
    expect(errorOf("2 3")).toBe("Unexpected number");
  });

  it("error HTML escapes markup-significant characters", () => {
    expect(exprErrorHtml('Unrecognized punctuation character "<"')).toBe(
      '<strong class="error">Expression error: Unrecognized punctuation character "&lt;".</strong>',
    );
  });
});
