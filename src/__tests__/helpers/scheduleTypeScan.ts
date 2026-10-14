import ts from 'typescript';
import {ScheduleTypeEnum} from '@themeparks/typelib';

/**
 * Reads, from source, the `type` that schedule entries can carry.
 *
 * Three scans, each closing a gap the others leave:
 *
 * 1. `scanScheduleTypes`: every object literal that is a schedule entry (it has
 *    `type`, `openingTime` and `closingTime`) has its `type` resolved to string
 *    literals:
 *      - a literal, with `as`, `!`, `satisfies` and parentheses looked through;
 *      - `ScheduleTypeEnum.<Member>`, the member checked against the enum;
 *      - either branch of `a ? b : c`, and either side of `||` / `??`;
 *      - an identifier, through its declaration and every assignment to it in
 *        the nearest enclosing function that declares it (the whole file when
 *        it is declared outside one), or, for a parameter, the string literal
 *        types it is annotated with;
 *      - with a type checker, any other expression whose type is a union of
 *        string literals (`row.type` where `row` is a `ScheduleEntry`).
 *    Anything else comes back in `unresolved`. A destructured name is never
 *    read through an outer variable of the same name.
 *
 * 2. `scanPublishedSchedules`: every `{id, schedule}` object, which is how a
 *    park hands schedules to the framework, has the element type of its
 *    `schedule` read from the type checker, `as` casts stripped. It must be a
 *    union of string literals. This is what makes the typing of the arrays
 *    matter: a `schedule` that is `any[]`, or whose entries have `type: string`,
 *    fails here, and one typed `ScheduleEntry[]` is held to the schedule
 *    definition by the compiler wherever it is filled in.
 *
 * 3. `scanTypeAssignments`: every `x.type = ...` and `x['type'] = ...`. The
 *    compiler does not stop `(e: any) => { e.type = 'PARK_OPEN' }` on a typed
 *    array. None exists today.
 *
 * What none of them sees: an entry assembled somewhere that never reaches a
 * `{id, schedule}` literal or one of the shapes above, and a value that is a
 * real string at run time but typed as a literal union through a cast the scan
 * does not look inside (`x as ScheduleType`). Typing the arrays and keeping
 * casts out of the entries is what keeps those closed.
 */

export type ScheduleTypeFinding = {
  file: string;
  line: number;
  /** The `type` property (or assignment, or `schedule` initializer) as written. */
  text: string;
  /** Every string literal the type can take. */
  values: string[];
  /** Parts that could not be reduced to a literal, or are typed wider than one. */
  unresolved: string[];
};

type Resolved = {values: Set<string>; unresolved: string[]};
type Ctx = {sf: ts.SourceFile; checker?: ts.TypeChecker};

const ENUM_MEMBERS = ScheduleTypeEnum as unknown as Record<string, string>;
const OPT_OUT = 'schedule-type-ok:';

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

/** `x as T`, `<T>x`, `x!`, `x satisfies T` and `(x)` all stand for `x`. */
function stripWrappers(e: ts.Node): ts.Node {
  let n = e;
  while (
    ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)
  ) n = n.expression;
  return n;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
  if (!p.name) return undefined;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  if (ts.isComputedPropertyName(p.name)) {
    const inner = stripWrappers(p.name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  }
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

/** True if `name` is bound by destructuring within `scope`, which no assignment search can follow. */
function boundByDestructuring(name: string, scope: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && n.name.text === name) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** The string literals a type allows; anything wider comes back in `other`. */
export function literalsOfType(checker: ts.TypeChecker, type: ts.Type): {values: string[]; other: string[]} {
  const values: string[] = [];
  const other: string[] = [];
  const visit = (t: ts.Type) => {
    if (t.isUnion()) t.types.forEach(visit);
    else if (t.flags & ts.TypeFlags.StringLiteral) values.push((t as ts.StringLiteralType).value);
    else if (t.flags & ts.TypeFlags.Never) return;
    else other.push(checker.typeToString(t));
  };
  visit(type);
  return {values, other};
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

/** An expression no source tracking can follow, read from its type if there is a checker. */
function viaChecker(expr: ts.Node, ctx: Ctx): Resolved {
  const text = expr.getText(ctx.sf);
  if (!ctx.checker) return {values: new Set(), unresolved: [text]};
  const r = literalsOfType(ctx.checker, ctx.checker.getTypeAtLocation(expr));
  if (r.other.length || !r.values.length) {
    return {values: new Set(r.values), unresolved: [`${text}: ${r.other.join(' | ') || 'no literal type'}`]};
  }
  return {values: new Set(r.values), unresolved: []};
}

function resolve(expr: ts.Node, ctx: Ctx, seen: Set<string> = new Set()): Resolved {
  const {sf} = ctx;
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
    merge(resolve(expr.expression, ctx, seen));
  } else if (ts.isConditionalExpression(expr)) {
    merge(resolve(expr.whenTrue, ctx, seen));
    merge(resolve(expr.whenFalse, ctx, seen));
  } else if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken || expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    merge(resolve(expr.left, ctx, seen));
    merge(resolve(expr.right, ctx, seen));
  } else if (
    (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) &&
    ts.isIdentifier(expr.expression) && expr.expression.text === 'ScheduleTypeEnum'
  ) {
    const member = ts.isPropertyAccessExpression(expr)
      ? expr.name.text
      : ts.isStringLiteral(expr.argumentExpression) ? expr.argumentExpression.text : undefined;
    if (member === undefined) unresolved.push(expr.getText(sf));
    // A member the enum lacks is returned as written so it is reported as a bad type.
    else values.add(Object.prototype.hasOwnProperty.call(ENUM_MEMBERS, member) ? ENUM_MEMBERS[member] : `ScheduleTypeEnum.${member}`);
  } else if (ts.isIdentifier(expr)) {
    const key = `${expr.text}@${expr.getStart(sf)}`;
    if (seen.has(key)) return {values, unresolved};
    seen.add(key);
    let found = false;
    for (let scope: ts.Node | undefined = enclosingScope(expr, sf); scope && !found; scope = scope === sf ? undefined : enclosingScope(scope, sf)) {
      if (boundByDestructuring(expr.text, scope)) {
        merge(viaChecker(expr, ctx));
        found = true;
        break;
      }
      const param = isFunctionLike(scope)
        ? scope.parameters.find(p => ts.isIdentifier(p.name) && p.name.text === expr.text)
        : undefined;
      const sources = assignmentsTo(expr.text, scope);
      if (param) merge(literalTypes(param.type, sf, expr.text));
      for (const s of sources) merge(resolve(s, ctx, seen));
      found = !!param || sources.length > 0;
    }
    if (!found) merge(viaChecker(expr, ctx));
  } else {
    merge(viaChecker(expr, ctx));
  }
  return {values, unresolved};
}

const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const squash = (n: ts.Node, sf: ts.SourceFile) => n.getText(sf).replace(/\s+/g, ' ').slice(0, 120);

function initializer(p: ts.ObjectLiteralElementLike): ts.Node {
  return ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : p;
}

/** Scan 1: the `type` of every schedule entry literal in a parsed file. */
export function scanSourceFile(file: string, sf: ts.SourceFile, checker?: ts.TypeChecker): ScheduleTypeFinding[] {
  const ctx: Ctx = {sf, checker};
  const out: ScheduleTypeFinding[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const byName = new Map<string, ts.ObjectLiteralElementLike>();
      for (const p of n.properties) {
        const name = propertyName(p);
        if (name) byName.set(name, p);
      }
      if (byName.has('type') && byName.has('openingTime') && byName.has('closingTime')) {
        const prop = byName.get('type')!;
        const r = resolve(initializer(prop), ctx);
        out.push({file, line: lineOf(sf, prop), text: squash(prop, sf), values: [...r.values].sort(), unresolved: r.unresolved});
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Scan 1 on source text alone, so a property read off another object cannot be resolved. */
export function scanScheduleTypes(file: string, source: string): ScheduleTypeFinding[] {
  return scanSourceFile(file, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
}

/** Scan 2: what each `{id, schedule}` object publishes, by the types the checker sees. */
export function scanPublishedSchedules(file: string, sf: ts.SourceFile, checker: ts.TypeChecker): ScheduleTypeFinding[] {
  const out: ScheduleTypeFinding[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const byName = new Map<string, ts.ObjectLiteralElementLike>();
      for (const p of n.properties) {
        const name = propertyName(p);
        if (name) byName.set(name, p);
      }
      const prop = byName.get('schedule');
      if (prop && byName.has('id')) {
        const expr = stripWrappers(initializer(prop));
        const arrayType = checker.getTypeAtLocation(expr);
        const entryType = checker.getIndexTypeOfType(arrayType, ts.IndexKind.Number);
        const finding: ScheduleTypeFinding = {file, line: lineOf(sf, prop), text: squash(prop, sf), values: [], unresolved: []};
        if (arrayType.flags & ts.TypeFlags.Any) {
          finding.unresolved.push('schedule is any');
        } else if (entryType && !(entryType.flags & ts.TypeFlags.Never)) {
          if (entryType.flags & ts.TypeFlags.Any) {
            finding.unresolved.push('schedule entries are any');
          } else {
            const typeProp = checker.getPropertyOfType(entryType, 'type');
            if (!typeProp) {
              finding.unresolved.push(`entries (${checker.typeToString(entryType).slice(0, 60)}) have no type`);
            } else {
              const r = literalsOfType(checker, checker.getTypeOfSymbolAtLocation(typeProp, expr));
              finding.values = r.values.sort();
              if (r.other.length) finding.unresolved.push(`entry type is ${r.other.join(' | ')}`);
            }
          }
        } else if (!entryType) {
          finding.unresolved.push(`schedule is ${checker.typeToString(arrayType).slice(0, 60)}`);
        }
        out.push(finding);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Scan 3: assignments to a property called `type`, which the compiler cannot hold to the definition through `any`. */
export function scanTypeAssignments(file: string, sf: ts.SourceFile, checker?: ts.TypeChecker): ScheduleTypeFinding[] {
  const ctx: Ctx = {sf, checker};
  const lines = sf.text.split('\n');
  const out: ScheduleTypeFinding[] = [];
  const isTypeMember = (n: ts.Node) =>
    (ts.isPropertyAccessExpression(n) && n.name.text === 'type') ||
    (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(n.argumentExpression)) &&
      n.argumentExpression.text === 'type');
  const visit = (n: ts.Node) => {
    if (
      ts.isBinaryExpression(n) && isTypeMember(n.left) &&
      [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(n.operatorToken.kind)
    ) {
      const line = lineOf(sf, n);
      const marked = [lines[line - 1], lines[line - 2]].some(l => l?.includes(OPT_OUT));
      if (!marked) {
        const r = resolve(n.right, ctx);
        out.push({file, line, text: squash(n, sf), values: [...r.values].sort(), unresolved: r.unresolved});
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * A program over `rootNames` with the repository's compiler options, so the
 * checker sees park code exactly as `npm run build` does.
 */
export function createProgram(root: string, rootNames: string[], virtualFiles: Record<string, string> = {}): ts.Program {
  const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')!;
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const options: ts.CompilerOptions = {...parsed.options, noEmit: true};
  const host = ts.createCompilerHost(options);
  const realGetSourceFile = host.getSourceFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);
  host.fileExists = f => f in virtualFiles || realFileExists(f);
  host.readFile = f => virtualFiles[f] ?? realReadFile(f);
  host.getSourceFile = (f, lang, onError, shouldCreate) =>
    f in virtualFiles ? ts.createSourceFile(f, virtualFiles[f], lang, true) : realGetSourceFile(f, lang, onError, shouldCreate);
  return ts.createProgram([...rootNames, ...Object.keys(virtualFiles)], options, host);
}

/** The files the build compiles, from the repository's tsconfig. */
export function buildFileNames(root: string): string[] {
  const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')!;
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(cfg.config, ts.sys, root).fileNames;
}
