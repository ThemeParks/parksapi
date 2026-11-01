/**
 * Entity names and ids in the review page come from park APIs and from the
 * wiki, so they are not trusted. The page is same-origin with the commit
 * endpoint, so a name that runs script is a way to start a commit.
 *
 * The inline script in ui/index.html is loaded into a vm context with just
 * enough stubs for its top level to run, then the functions that build HTML
 * are called with hostile values. Nothing here needs a browser: the checks are
 * on the HTML strings those functions return.
 */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'ui', 'index.html'), 'utf-8');
const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];

/** Breaks out of a double-quoted attribute and adds an event handler. */
const ATTRIBUTE_BREAKOUT = '" onfocus="alert(1)" autofocus="';
const TAG_INJECTION = '<img src=x onerror=alert(1)>';

function loadPage(): vm.Context {
  const context = vm.createContext({
    // load() runs at the top level and waits on this forever.
    fetch: () => new Promise(() => {}),
    document: {getElementById: () => ({})},
    console,
  });
  vm.runInContext(script, context);
  return context;
}

function call(context: vm.Context, source: string): unknown {
  return vm.runInContext(source, context);
}

describe('esc', () => {
  const context = loadPage();
  const esc = (value: unknown) => {
    context.input = value;
    return call(context, 'esc(input)') as string;
  };

  test('escapes markup and both quote characters', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  test('null and undefined become empty', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  test('numbers are written as text', () => {
    expect(esc(42)).toBe('42');
  });
});

describe('renderPairDropdown', () => {
  test('a hostile id or name cannot leave its attribute', () => {
    const context = loadPage();
    context.mapping = {entityType: 'ATTRACTION'};
    call(
      context,
      `data = {
         mappings: [],
         allNewEntities: [{newId: ${JSON.stringify(ATTRIBUTE_BREAKOUT)}, name: ${JSON.stringify(
           ATTRIBUTE_BREAKOUT + TAG_INJECTION,
         )}, entityType: 'ATTRACTION'}],
       };`,
    );
    const out = call(context, 'renderPairDropdown(0, mapping)') as string;

    const options = [...out.matchAll(/<option ([^>]*)>/g)].slice(1); // first is "Select..."
    expect(options).toHaveLength(1);
    // Exactly value="..." and data-name="...": nothing was added.
    expect((options[0][1].match(/="/g) ?? []).length).toBe(2);
    expect(out).not.toContain('<img');
    expect(out).toContain('&quot; onfocus=&quot;');
  });
});

describe('renderRowHtml', () => {
  test('every field from the wiki or the park is escaped', () => {
    const context = loadPage();
    context.row = {
      oldExternalId: TAG_INJECTION,
      oldName: TAG_INJECTION,
      entityType: TAG_INJECTION,
      newExternalId: TAG_INJECTION + TAG_INJECTION,
      newName: TAG_INJECTION,
      confidence: 'fuzzy',
      confidenceScore: 50,
      distance: null,
      status: 'confirmed',
    };
    call(context, 'data = {mappings: [row], allNewEntities: []};');
    const out = call(context, 'renderRowHtml(0, row)') as string;
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});

describe('renderProgressLine', () => {
  test('ids, names and errors are escaped', () => {
    const context = loadPage();
    context.event = {
      success: false,
      name: TAG_INJECTION,
      oldId: TAG_INJECTION,
      newId: TAG_INJECTION,
      error: TAG_INJECTION,
    };
    const out = call(context, 'renderProgressLine(event)') as string;
    expect(out).not.toContain('<img');
    expect(out.match(/&lt;img/g)).toHaveLength(4);
  });

  test('a success line is marked as one', () => {
    const context = loadPage();
    context.event = {success: true, name: 'Ride', oldId: 'a', newId: 'b'};
    const out = call(context, 'renderProgressLine(event)') as string;
    expect(out).toContain('class="success"');
    expect(out).toContain('Ride a → b');
  });
});
