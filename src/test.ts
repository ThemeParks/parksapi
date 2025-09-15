import {Destination} from "./destination";
import {http, HTTPObj} from "./http";

class CubeWorld extends Destination {
  getDestinationName(): string {
    return "Cube World - The best theme park in the world!";
  }

  @http()
  async fetchAttractions(): Promise<HTTPObj> {
    // For debugging, we're just fetching Walt Disney World's attractions here
    return {
      method: "GET",
      url: "https://api.themeparks.wiki/v1/entity/e957da41-3552-4cf6-b636-5babc5cbc4e5/children",
    } as HTTPObj;
  }
}

const testObj = new CubeWorld();
console.log("Destination Name:", testObj.getDestinationName());

const resp = await testObj.fetchAttractions();
const jsonData = await resp.json();
console.log("Fetch Attractions Response:", jsonData);
