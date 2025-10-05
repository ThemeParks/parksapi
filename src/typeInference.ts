/**
 * Type inference utility for generating TypeScript types from JSON responses
 */

/**
 * Inferred type representation
 */
export type InferredType =
  | { kind: 'primitive'; type: 'string' | 'number' | 'boolean' | 'null' }
  | { kind: 'array'; elementType: InferredType }
  | { kind: 'object'; properties: Record<string, InferredType> }
  | { kind: 'union'; types: InferredType[] };

/**
 * Infer type from a single JSON value
 */
export function inferType(value: any): InferredType {
  if (value === null) {
    return { kind: 'primitive', type: 'null' };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      // Empty array - infer as any[]
      return { kind: 'array', elementType: { kind: 'primitive', type: 'null' } };
    }

    // Infer type from all elements and merge
    const elementTypes = value.map(inferType);
    const mergedElementType = mergeTypes(elementTypes);
    return { kind: 'array', elementType: mergedElementType };
  }

  const typeOfValue = typeof value;

  if (typeOfValue === 'string') {
    return { kind: 'primitive', type: 'string' };
  }

  if (typeOfValue === 'number') {
    return { kind: 'primitive', type: 'number' };
  }

  if (typeOfValue === 'boolean') {
    return { kind: 'primitive', type: 'boolean' };
  }

  if (typeOfValue === 'object') {
    const properties: Record<string, InferredType> = {};
    for (const [key, val] of Object.entries(value)) {
      properties[key] = inferType(val);
    }
    return { kind: 'object', properties };
  }

  // Unknown type - treat as null
  return { kind: 'primitive', type: 'null' };
}

/**
 * Merge multiple types into a single type (creating unions when necessary)
 */
export function mergeTypes(types: InferredType[]): InferredType {
  if (types.length === 0) {
    return { kind: 'primitive', type: 'null' };
  }

  if (types.length === 1) {
    return types[0];
  }

  // Group types by kind
  const primitives = types.filter(t => t.kind === 'primitive') as Array<{ kind: 'primitive'; type: string }>;
  const arrays = types.filter(t => t.kind === 'array') as Array<{ kind: 'array'; elementType: InferredType }>;
  const objects = types.filter(t => t.kind === 'object') as Array<{ kind: 'object'; properties: Record<string, InferredType> }>;
  const unions = types.filter(t => t.kind === 'union') as Array<{ kind: 'union'; types: InferredType[] }>;

  // Flatten unions
  const flattenedTypes: InferredType[] = [];

  // Add primitives
  const uniquePrimitiveTypes = new Set(primitives.map(p => p.type));
  for (const type of uniquePrimitiveTypes) {
    flattenedTypes.push({ kind: 'primitive', type: type as any });
  }

  // Merge arrays
  if (arrays.length > 0) {
    const arrayElementTypes = arrays.map(a => a.elementType);
    const mergedElementType = mergeTypes(arrayElementTypes);
    flattenedTypes.push({ kind: 'array', elementType: mergedElementType });
  }

  // Merge objects
  if (objects.length > 0) {
    const mergedObject = mergeObjects(objects);
    flattenedTypes.push(mergedObject);
  }

  // Flatten nested unions
  for (const union of unions) {
    flattenedTypes.push(...union.types);
  }

  if (flattenedTypes.length === 1) {
    return flattenedTypes[0];
  }

  return { kind: 'union', types: flattenedTypes };
}

/**
 * Merge multiple object types into a single object type
 * Properties that exist in all objects are required
 * Properties that exist in some objects are optional
 */
function mergeObjects(objects: Array<{ kind: 'object'; properties: Record<string, InferredType> }>): InferredType {
  if (objects.length === 0) {
    return { kind: 'object', properties: {} };
  }

  if (objects.length === 1) {
    return objects[0];
  }

  // Collect all property names
  const allPropertyNames = new Set<string>();
  for (const obj of objects) {
    for (const key of Object.keys(obj.properties)) {
      allPropertyNames.add(key);
    }
  }

  // Merge properties
  const mergedProperties: Record<string, InferredType> = {};
  for (const propName of allPropertyNames) {
    const propTypes: InferredType[] = [];

    for (const obj of objects) {
      if (obj.properties[propName]) {
        propTypes.push(obj.properties[propName]);
      }
    }

    // If property doesn't exist in all objects, it's optional (add undefined)
    if (propTypes.length < objects.length) {
      propTypes.push({ kind: 'primitive', type: 'null' });
    }

    mergedProperties[propName] = mergeTypes(propTypes);
  }

  return { kind: 'object', properties: mergedProperties };
}

/**
 * Generate TypeScript interface code from an inferred type
 */
export function generateTypeScript(type: InferredType, interfaceName: string = 'GeneratedType', indent: number = 0): string {
  const indentStr = '  '.repeat(indent);

  if (type.kind === 'primitive') {
    if (type.type === 'null') {
      return 'any';
    }
    return type.type;
  }

  if (type.kind === 'array') {
    const elementTypeStr = generateTypeScript(type.elementType, interfaceName, indent);
    // If element type is complex, wrap in parentheses
    if (type.elementType.kind === 'union') {
      return `(${elementTypeStr})[]`;
    }
    return `${elementTypeStr}[]`;
  }

  if (type.kind === 'union') {
    const typeStrings = type.types.map(t => generateTypeScript(t, interfaceName, indent));
    // Remove duplicates
    const uniqueTypeStrings = Array.from(new Set(typeStrings));
    return uniqueTypeStrings.join(' | ');
  }

  if (type.kind === 'object') {
    const properties = Object.entries(type.properties);

    if (properties.length === 0) {
      return '{}';
    }

    const lines: string[] = [];
    lines.push(`{`);

    for (const [key, propType] of properties) {
      const propTypeStr = generateTypeScript(propType, interfaceName, indent + 1);
      const propIndent = '  '.repeat(indent + 1);

      // Check if property is optional (has null in union)
      const isOptional = isOptionalType(propType);
      const optionalMarker = isOptional ? '?' : '';

      // Remove null from the type if it's optional
      const cleanedTypeStr = isOptional ? removeNullFromType(propTypeStr) : propTypeStr;

      lines.push(`${propIndent}${key}${optionalMarker}: ${cleanedTypeStr};`);
    }

    lines.push(`${indentStr}}`);
    return lines.join('\n');
  }

  return 'any';
}

/**
 * Check if a type includes null (making it optional)
 */
function isOptionalType(type: InferredType): boolean {
  if (type.kind === 'union') {
    return type.types.some(t => t.kind === 'primitive' && t.type === 'null');
  }
  return false;
}

/**
 * Remove null from a type string (for optional properties)
 */
function removeNullFromType(typeStr: string): string {
  // Split by union and filter out 'null' and 'any'
  const types = typeStr.split('|').map(s => s.trim()).filter(t => t !== 'null' && t !== 'any');

  if (types.length === 0) {
    return 'any';
  }

  if (types.length === 1) {
    return types[0];
  }

  return types.join(' | ');
}

/**
 * Generate a complete TypeScript interface file with header comment
 */
export function generateInterfaceFile(
  interfaceName: string,
  type: InferredType,
  requestParams: Array<{ params: string; timestamp: string }>
): string {
  const lines: string[] = [];

  // Add header comment
  lines.push('/**');
  lines.push(` * Auto-generated type for ${interfaceName}`);
  lines.push(' * Generated by ParksAPI type detection');
  lines.push(' *');
  lines.push(' * Based on the following HTTP requests:');
  for (const req of requestParams) {
    lines.push(` *   - ${req.timestamp}: ${req.params}`);
  }
  lines.push(' */');
  lines.push('');

  // Generate interface
  const typeBody = generateTypeScript(type, interfaceName, 0);

  // If it's an object type, create an interface
  if (type.kind === 'object') {
    lines.push(`export interface ${interfaceName} ${typeBody}`);
  } else {
    // For non-object types, create a type alias
    lines.push(`export type ${interfaceName} = ${typeBody};`);
  }

  lines.push('');

  return lines.join('\n');
}
