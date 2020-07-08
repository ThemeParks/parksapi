/**
 * Base Config Object
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
