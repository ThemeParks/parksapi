import mingo from 'mingo';

/**
 * Build a mongo-style filter function
 * @param {object} conf
 * @return {function}
 */
export function Sieve(conf = {}) {
  const query = new mingo.Query(conf);
  return (x) => query.test(x);
}

export default Sieve;
