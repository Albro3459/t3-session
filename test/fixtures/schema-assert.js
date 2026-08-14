import assert from "node:assert/strict";

// A general walk over the subset of JSON Schema this package's bundled schemas use:
// type unions, const, enum, minimum, required, additionalProperties, array items, and $ref.
// Walking the schema rather than hand-listing each field means a property added to a schema
// is enforced automatically, instead of silently going unchecked until someone remembers it.
// The alternative would be a JSON-schema dependency, which this package does not take.
function typeMatches(value, type) {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    default: return false;
  }
}

function assertDeclaredType(value, propertySchema, label) {
  const types = Array.isArray(propertySchema.type) ? propertySchema.type : [propertySchema.type];
  assert.ok(
    types.some((type) => typeMatches(value, type)),
    `${label} expected type ${types.join("|")} but got ${JSON.stringify(value)}`,
  );
}

function resolveSchemaRef(schema, rootSchema) {
  if (schema && typeof schema.$ref === "string") {
    const match = schema.$ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
    assert.ok(match, `unsupported schema reference ${schema.$ref}`);
    const definitions = rootSchema[match[1]];
    const name = match[2];
    assert.ok(definitions && Object.hasOwn(definitions, name), `missing schema reference ${schema.$ref}`);
    return definitions[name];
  }
  return schema;
}

export function assertMatchesSchema(value, rawSchema, rootSchema, label) {
  const schema = resolveSchemaRef(rawSchema, rootSchema);

  if (Object.hasOwn(schema, "const")) {
    assert.equal(value, schema.const, `${label} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.type !== undefined) {
    assertDeclaredType(value, schema, label);
  }
  if (schema.enum !== undefined) {
    assert.ok(schema.enum.includes(value), `${label} outside enum: ${JSON.stringify(value)}`);
  }
  if (schema.minimum !== undefined && typeof value === "number") {
    assert.ok(value >= schema.minimum, `${label} below minimum ${schema.minimum}`);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => assertMatchesSchema(item, schema.items, rootSchema, `${label}[${index}]`));
  }

  const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isPlainObject || schema.properties === undefined) {
    return;
  }

  for (const key of schema.required ?? []) {
    assert.ok(Object.hasOwn(value, key), `${label} missing required key "${key}"`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      assert.ok(Object.hasOwn(schema.properties, key), `${label} has unexpected key "${key}"`);
    }
  }
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (Object.hasOwn(value, key)) {
      assertMatchesSchema(value[key], propertySchema, rootSchema, `${label}.${key}`);
    }
  }
}
