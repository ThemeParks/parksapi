import Database from '../database.js';
import WDWDB from './wdwdb.js';

/**
 * @inheritdoc
 */
export class DatabaseWDW extends Database {
  /**
   * @inheritdoc
   * @param {object} options
   */
  constructor(options = {}) {
    super(options);

    this.db = new WDWDB();
  }

  /**
   * @inheritdoc
   */
  async _getEntities() {
    // make sure our synced database is up-to-date
    await this.db.init();
  }
}

export default DatabaseWDW;
