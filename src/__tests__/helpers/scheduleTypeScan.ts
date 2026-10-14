import ts from 'typescript';

/**
 * Finds the `type` of every schedule entry a source file builds.
 *
 * A schedule entry is recognised by its shape: an object literal carrying
 * `type`, `openingTime` and `closingTime`. Each one's `type` expression is
 * resolved to the string literals it can take:
 *
 *   - a literal, with `as`, `!`, `satisfies` and parentheses looked through;
 *   - either branch of `a ? b : c`, and either side of `||` / `??`;
 *   - an identifier, through its declaration and every assignment to it in the
 *     nearest enclosing function that declares it (the whole file when it is
 *     declared outside one), or, for a parameter, the string literal types it
 *     is annotated with, which the compiler holds the callers to;
 *   - `something.type`, through the other entry literals of the same file.
 *
 * Anything else comes back in `unresolved` rather than being guessed at, so a
 * type that cannot be read from the source fails the check instead of passing
 * it.
 */

export type ScheduleTypeFinding = {
  file: string;
  line: number;
  /** The `type` property as written. */
  text: string;
  /** Every string literal the type can take. */
  values: string[];
  /** Parts of the expression that could not be reduced to a literal. */
  unresolved: string[];
};

type Resolved = {values: Set<string>; unresolved: string[]};

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
  if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
  return undefined;
}

function enclosingScope(node: ts.Node, sf: ts.SourceFile): ts.Node {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (isFunctionLike(n)) return n;
  }
  return sf;
}

/** Every initializer of, and assignment to, a variable called `name` within `scope`. */
function assignmentsTo(name: string, scope: ts.Node): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      out.push(n.initializer);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) && n.left.text === name
    ) {
      out.push(n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}

/** The string literals a parameter's type annotation allows, or `unresolved` if it allows more. */
function literalTypes(type: ts.TypeNode | undefined, sf: ts.SourceFile, name: string): Resolved {
  const values = new Set<string>();
  const unresolved: string[] = [];
  const visit = (t: ts.TypeNode) => {
    if (ts.isParenthesizedTypeNode(t)) visit(t.type);
    else if (ts.isUnionTypeNode(t)) t.types.forEach(visit);
    else if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) values.add(t.literal.text);
    else unresolved.push(`${name}: ${t.getText(sf)}`);
  };
  if (type) visit(type);
  else unresolved.push(`${name} (parameter with no type)`);
  return {values, unresolved};
}

function resolve(
  expr: ts.Node,
  sf: ts.SourceFile,
  siblingValues: () => Set<string>,
  seen: Set<string> = new Set(),
): Resolved {
  const values = new Set<string>();
  const unresolved: string[] = [];
  const merge = (r: Resolved) => {
    r.values.forEach(v => values.add(v));
    unresolved.push(...r.unresolved);
  };

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    values.add(expr.text);
  } else if (
    ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)
  ) {
    merge(resolve(expr.expression, sf, siblingValues, seen));
  } else if (ts.isConditionalExpression(expr)) {
    merge(resolve(expr.whenTrue, sf, siblingValues, seen));
    merge(resolve(expr.whenFalse, sf, siblingValues, seen));
  } else if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken || expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    merge(resolve(expr.left, sf, siblingValues, seen));
    merge(resolve(expr.right, sf, siblingValues, seen));
  } else if (ts.isIdentifier(expr)) {
    const key = `${expr.text}@${expr.getStart(sf)}`;
    if (seen.has(key)) return {values, unresolved};
    seen.add(key);
    let found = false;
    for (let scope: ts.Node | undefined = enclosingScope(expr, sf); scope && !found; scope = scope === sf ? undefined : enclosingScope(scope, sf)) {
      const param = isFunctionLike(scope)
        ? scope.parameters.find(p => ts.isIdentifier(p.name) && p.name.text === expr.text)
        : undefined;
      const sources = assignmentsTo(expr.text, scope);
      if (param) merge(literalTypes(param.type, sf, expr.text));
      for (const s of sources) merge(resolve(s, sf, siblingValues, seen));
      found = !!param || sources.length > 0;
    }
    if (!found) unresolved.push(expr.getText(sf));
  } else if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'type') {
    const sibling = siblingValues();
    if (!sibling.size) unresolved.push(expr.getText(sf));
    sibling.forEach(v => values.add(v));
  } else {
    unresolved.push(expr.getText(sf));
  }
  return {values, unresolved};
}

export function scanScheduleTypes(file: string, source: string): ScheduleTypeFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  // Pass 1: the entry literals themselves.
  const entries: Array<{prop: ts.ObjectLiteralElementLike}> = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const byName = new Map<string, ts.ObjectLiteralElementLike>();
      for (const p of n.properties) {
        const name = propertyName(p);
        if (name) byName.set(name, p);
      }
      if (byName.has('type') && byName.has('openingTime') && byName.has('closingTime')) {
        entries.push({prop: byName.get('type')!});
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const initializer = (p: ts.ObjectLiteralElementLike): ts.Node =>
    ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : p;

  // `x.type` is read through the file's other entries, which are scanned
  // without that fallback so the lookup cannot feed on itself.
  let direct: Set<string> | undefined;
  const directValues = () => {
    if (!direct) {
      direct = new Set();
      for (const {prop} of entries) {
        const init = initializer(prop);
        if (ts.isPropertyAccessExpression(init)) continue;
        resolve(init, sf, () => new Set()).values.forEach(v => direct!.add(v));
      }
    }
    return direct;
  };

  return entries.map(({prop}) => {
    const r = resolve(initializer(prop), sf, directValues);
    return {
      file,
      line: sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1,
      text: prop.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
      values: [...r.values].sort(),
      unresolved: r.unresolved,
    };
  });
}
