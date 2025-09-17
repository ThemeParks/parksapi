import {Destination} from "./destination";
import {http, HTTPObj} from "./http";
import {EntityType, EntityTypeEnum} from "./types/entities";

class CubeWorld extends Destination {
  getDestinationName(): string {
    return "Cube World - The best theme park in the world!";
  }

  @http({
    cacheSeconds: 300, // Cache the response for 5 minutes
  })
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
setTimeout(async () => {
  const resp2 = await testObj.fetchAttractions();
}, 2000);
const jsonData = await resp.json();
console.log("Fetch Attractions Response:", jsonData.children.length);

const wdw: EntityType = {
  id: "wdw",
  name: "Walt Disney World",
  location: {latitude: 28.3852, longitude: -81.5639},
  timezone: "America/New_York",
  entityType: EntityTypeEnum.DESTINATION,
};

const magicKingdom: EntityType = {
  id: "wdw-mk",
  name: "Magic Kingdom",
  location: {latitude: 28.4177, longitude: -81.5812},
  timezone: "America/New_York",
  entityType: EntityTypeEnum.PARK,
  destinationId: "wdw",
  parentId: "wdw",
};

const ents: EntityType[] = [wdw, magicKingdom];

console.log("Entities:", ents);

const parks = ents.filter(e => e.entityType === EntityTypeEnum.PARK);
console.log("Parks:", parks);
