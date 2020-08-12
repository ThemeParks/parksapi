import {promises as fs} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import ConfigBase from './configBase.js';
import {runInThisContext} from 'vm';

/**
 * A basic .har file writer
 */
export class HarWriter extends ConfigBase {
  /**
   * Construct a new HarWriter
   * @param {object} options
   */
  constructor(options = {}) {
    options.filename = options.filename || 'debug.har';

    super(options);

    this.entries = [];
    this._dirty = false;
    this._writeTimeout = null;
  }

  /**
   * Record a single HTTP request entry
   * @param {object} data
   */
  async recordEntry(data) {
    this.entries.push(data);

    // mark as dirty, and schedule a write for 0.25 seconds from now
    this._dirty = true;
    clearTimeout(this._writeTimeout);
    this._writeTimeout = setTimeout(this.write.bind(this), 250);
  }

  /**
   * Write .har export to disk
   */
  async write() {
    if (this._dirty) {
      const filePath = path.join(process.cwd(), `${this.config.filename}`);
      await fs.writeFile(filePath, JSON.stringify(await this.toJSON(), null, 2));
      this._dirty = false;
    }
  }

  /**
   * Get the current version of this module
   */
  async getProjectVersion() {
    try {
      const packageFile = await fs.readFile(
          path.join(
              path.dirname(fileURLToPath(import.meta.url)),
              '..',
              'package.json',
          ));
      const packageJSON = JSON.parse(packageFile);
      return packageJSON.version;
    } catch (e) {
      console.error(e);
      return '';
    }
  }

  /**
   * Build the "log" section of the HAR export
   * @return {object}
   */
  async createLogObject() {
    return {
      version: '1.2',
      creator: {
        name: 'ThemeParks.wiki',
        version: await this.getProjectVersion(),
        comment: '',
      },
      browser: {
        name: 'ThemeParks.wiki',
        version: await this.getProjectVersion(),
        comment: '',
      },
      pages: [],
      entries: this.entries,
      comment: '',
    };
  }

  /**
   * Return HAR file as a JSON object
   * @return {object}
   */
  async toJSON() {
    return {
      log: await this.createLogObject(),
    };
  }
}

export default HarWriter;
