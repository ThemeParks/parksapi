export enum EntityTypeEnum {
  DESTINATION = 'DESTINATION',
  PARK = 'PARK',
  ATTRACTION = 'ATTRACTION',
  DINING = 'DINING',
  SHOW = 'SHOW',
  HOTEL = 'HOTEL',
};

export type TagType = {
  tag: string;
  tagName: string;
  id?: string;
  value?: any;
};

export type EntityType = {
  id: string;
  name: string;
  entityType: 'DESTINATION' | 'PARK' | 'ATTRACTION' | 'DINING' | 'SHOW' | 'HOTEL';
  destinationId?: string; // optional only for DESTINATION types, required for others
  parentId?: string;
  parkId?: string;
  location: {
    latitude: number;
    longitude: number;
  },
  timezone: string;
  tags?: TagType[];
};
