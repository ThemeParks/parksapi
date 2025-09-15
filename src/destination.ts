// Base class for all destinations
export abstract class Destination {
  /**
   * Get the name of the destination
   * @returns {string} The name of the destination
   */
  getDestinationName(): string {
    throw new Error("getDestinationName not implemented.");
  }
}
