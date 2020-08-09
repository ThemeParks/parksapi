const traverse = require('@babel/traverse').default;
const path = require('path');

// ESDoc plugin to print enums nicely in our documentation

const astStore = {};

/**
 * Store AST from previous ESDoc stages so we can access it when writing our doc HTML
 * @param {object} event
 */
function storeAST(event) {
  astStore[event.data.filePath] = event.data.ast;
}

/**
 * Find our variable, given an AST and enum name
 * @param {object} fileAst
 * @param {string} enumName
 * @return {array<object>}
 */
function findEnum(fileAst, enumName) {
  const enums = [];
  traverse(fileAst, {
    VariableDeclarator: (astPath) => {
      if (astPath.node.id.name === enumName) {
        const args = (astPath && astPath.node && astPath.node.init && astPath.node.init.arguments) ? astPath.node.init.arguments : undefined;
        if (args && args.length) {
          args[0].properties.forEach((prop) => {
            enums.push({
              key: prop.key.name,
              value: prop.value.value,
            });
          });
        }
      }
    },
  });
  return enums;
}

module.exports = {
  onHandleAST: storeAST,
  onHandleDocs(event) {
    event.data.docs.forEach((doc) => {
      if (doc.unknown && doc.unknown.find((t) => t.tagName === '@enum')) {
        const docFilePath = path.join(__dirname, '..', '..', '..', doc.importPath);
        const fileAst = astStore[docFilePath];
        if (fileAst) {
          const enumData = findEnum(fileAst, doc.name);
          doc.description = `${doc.description}<br /><ul>${enumData.map((e) => {
            return `<li>${doc.name}.${e.key}</li>`;
          }).join('')}</ul>`;
        }
      }
    });
  },
};
