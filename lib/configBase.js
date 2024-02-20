// load any environment variables from .env (if it exists)
import DotEnv from 'dotenv';
DotEnv.config();

import EventEmitter from 'events';

/**
 * Combine given options with environment variables
 * @param {object} options Incoming options
 * @return {object} Processed configuration options
 */
export function parseConfig(options = {}) {
  const configKeys = Object.keys(options);

  const config = {};

  options.configPrefixes = ['THEMEPARKS'].concat(
      options.configPrefixes || [],
  );

  // build this.config object with our settings
  configKeys.forEach((key) => {
    // default prefixes are either "classname_" or "THEMEPARKS_"
    //  classes can add more with configPrefixes
    options.configPrefixes.forEach((prefix) => {
      const configEnvName = `${prefix}_${key}`.toUpperCase();

      if (process.env[configEnvName]) {
        // console.log(`Using env variable ${configEnvName}`);
        config[key] = process.env[configEnvName];
        // console.log(` ${key}(env.${configEnvName})=${config[key]}`);
      }
    });

    if (config[key] === undefined) {
      config[key] = options[key];
    } else {
      // convert env variable to number if the base default is a number
      if (typeof config[key] === 'number') {
        config[key] = Number(config[key]);
      } else if (typeof config[key] === 'boolean') {
        // convert any boolean configs too
        config[key] = (config[key] === 'true');
      } /* and arrays */ else if (Array.isArray(config[key])) {
        config[key] = config[key].split(',');
      }
    }
  });

  return config;
}

/**
 * Base Config Object
 * Supports classes with a single argument "options"
 * These will be sorted into a member called "this.config" containing all the same keys
 *
 * Crucially, these can also be overriden through environment variables
 * For example, for a config option "timeout" for class Database, this could be overriden through either:
 *   env.THEMEPARKS_TIMEOUT (using a "global module name")
 *   env.DATABASE_TIMEOUT (using the class name)
 *
 * Classes can also add additional prefixes to the supported environment variables through:
 *   new ClassInstance({configPrefixes: ['myCustomPrefix']});
 * Which would also allow env.MYCUSTOMPREFIX_TIMEOUT to be used
 *
 * Note that a default value must be supplied for the environment variable to be processed
 * If the default value is a number, the environment variable will be cast to a number as well
 * @class
 */
export class ConfigBase extends EventEmitter {
  /**
   * A base class that can be configured through environment variables
   * @param {object} options Config for instantiating this object
   */
  constructor(options = {}) {
    super();

    options.configPrefixes = [this.constructor.name].concat(
        options.configPrefixes || [],
    );

    this.config = parseConfig(options || {});
  }
}

export default ConfigBase;
