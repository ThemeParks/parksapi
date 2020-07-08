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
 */
export default class ConfigBase {
  /**
   * A base class that can be configured through environment variables
   * @param {object} options Config for instantiating this object
   */
  constructor(options = {}) {
    const config = options || {};
    const configKeys = Object.keys(config);

    this.config = {};

    const className = this.constructor.name;

    const configPrefixes = [className, 'THEMEPARKS'].concat(
        options.configPrefixes || [],
    );

    // build this.config object with our settings
    configKeys.forEach((key) => {
      // default prefixes are either "classname_" or "THEMEPARKS_"
      //  classes can add more with configPrefixes
      configPrefixes.forEach((prefix) => {
        const configEnvName = `${prefix}_${key}`.toUpperCase();

        if (process.env[configEnvName]) {
          console.log(`Using env variable config for class ${className}`);
          this.config[key] = process.env[configEnvName];
          console.log(` ${key}(env.${configEnvName})=${this.config[key]}`);
        }
      });

      if (this.config[key] === undefined) {
        this.config[key] = config[key];
      } else {
        // convert env variable to number if the base default is a number
        if (typeof config[key] === 'number') {
          this.config[key] = Number(this.config[key]);
        }
      }
    });
  }
}
