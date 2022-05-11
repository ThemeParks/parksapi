import tp from '../lib/index.js';
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(process.argv[1]);

const ignoreList = [
  'envCallback',
  'configPrefixes',
  'name',
  'timezone',
  'cacheVersion',
];

const envs = [];

function envCallback(scope, variable) {
  if (ignoreList.indexOf(variable) >= 0) {
    return;
  }
  envs.push(`${scope.toUpperCase()}_${variable.toUpperCase()}`);
}

const parkIDs = Object.keys(tp.destinations);
for (const parkID of parkIDs) {
  try {
    const park = new tp.destinations[parkID]({
      envCallback,
    });
  } catch (err) {
  }
}

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md')).toString();
// replace everything inbetween <!-- BEGIN_ENV --> and <!-- END_ENV -->
const envRegex = /<!-- BEGIN_ENV -->([\s\S]*?)<!-- END_ENV -->/g;
// replace envs with new list
const envList = envs.join('\n');
let newReadme = readme.replace(envRegex, `<!-- BEGIN_ENV -->\n\`\`\`\n${envList}\n\`\`\`\n<!-- END_ENV -->`);

// replace everything inbetween <!-- BEGIN_DESTINATIONS --> and <!-- END_DESTINATIONS -->
const destinationsRegex = /<!-- BEGIN_DESTINATIONS -->([\s\S]*?)<!-- END_DESTINATIONS -->/g;
// replace destinations with new list
const destinationsList = parkIDs.map((x) => `* ${x}`).join('\n');
newReadme = newReadme.replace(destinationsRegex, `<!-- BEGIN_DESTINATIONS -->\n${destinationsList}\n<!-- END_DESTINATIONS -->`);

fs.writeFileSync(path.join(__dirname, '..', 'README.md'), newReadme);
