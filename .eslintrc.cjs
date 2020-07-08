module.exports = {
  'env': {
    'browser': true,
    'es2020': true,
  },
  'extends': [
    'google',
  ],
  'parserOptions': {
    'ecmaVersion': 11,
    'sourceType': 'module',
  },
  'rules': {
    'max-len': [2, {'code': 120, 'ignoreUrls': true}],
  },
};
