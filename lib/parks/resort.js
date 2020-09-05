import Entity from './entity.js';
import Park from './park.js';

/**
 * The base Resort object
 */
export class Resort extends Entity {
  /**
   * Construct a new empty Resort object
   * @param {object} options
   * @param {object} parkOptions Options to pass onto all parks within this resort
   */
  constructor(options = {}, parkOptions = {}) {
    super(options);

    // remember the passed-in park options to use for any new parks we create
    this._newParkOptions = parkOptions;

    // construct all our parks (unless Park objects are already handed to us)
    this._parks = [];

    // if we were passed-in park classes, construct them
    if (options.parks) {
      [].concat(options.parks).forEach((park) => {
        if (park instanceof Park) {
          this.addPark(park);
        } else {
          this.addParkClass(park);
        }
      });
    }
  }

  /**
   * Add a new park to this resort. Will cosntruct into a new Park object
   * @param {class<Park>} ParkClass
   */
  addParkClass(ParkClass) {
    const alreadyExist = this._parks.find((x) => x instanceof ParkClass);
    if (alreadyExist === undefined) {
      if (ParkClass instanceof Park) {
        const newPark = new ParkClass(this._newParkOptions);
        this._parks.push(newPark);
      } else {
        throw new Error(`Cannot construct new Park object from ${ParkClass}, not a Park class`);
      }
    }
  }

  /**
   * Add an already constructed park to this resort
   * @param {Park} parkObject
   */
  addPark(parkObject) {
    const alreadyExist = this._parks.find((x) => x.getParkUniqueID() === parkObject.getParkUniqueID());
    if (alreadyExist === undefined) {
      this._parks.push(parkObject);
    }
  }

  /**
   * Get all the parks within this resort
   * @return {array<Park>}
   */
  getParks() {
    return this._parks;
  }
}

export default Resort;
