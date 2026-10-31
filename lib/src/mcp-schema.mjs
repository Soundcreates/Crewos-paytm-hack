const schemaTypes = new Set(['null', 'object', 'array', 'integer', 'number', 'string', 'boolean']);
const schemaKeywords = new Set([
  '$schema', '$id', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'oneOf', 'allOf',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'minProperties', 'maxProperties', 'uniqueItems',
]);

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

export function isSupportedInputSchema(schema, depth = 0) {
  if (!isPlainObject(schema) || depth > 12 || Object.keys(schema).some((key) => !schemaKeywords.has(key))) return false;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => !schemaTypes.has(type))) return false;
  }
  if (schema.properties !== undefined && (!isPlainObject(schema.properties) || Object.values(schema.properties).some((item) => !isSupportedInputSchema(item, depth + 1)))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !isSupportedInputSchema(schema.additionalProperties, depth + 1)) return false;
  if (schema.items !== undefined && !isSupportedInputSchema(schema.items, depth + 1)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256)) return false;
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (schema[keyword] !== undefined && (!Array.isArray(schema[keyword]) || !schema[keyword].length || schema[keyword].length > 32 || schema[keyword].some((item) => !isSupportedInputSchema(item, depth + 1)))) return false;
  }
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (schema[keyword] !== undefined && !Number.isFinite(schema[keyword])) return false;
  }
  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (schema[keyword] !== undefined && (!Number.isSafeInteger(schema[keyword]) || schema[keyword] < 0)) return false;
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') return false;
  return true;
}

function schemaError(schema, value, path = 'input', depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 12) return `${path} uses an unsupported input schema.`;
  if (schema.const !== undefined && !deepEqual(value, schema.const)) return `${path} must match its allowed value.`;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) return `${path} is outside its allowed values.`;
  for (const [keyword, matchCount] of [['anyOf', 1], ['oneOf', 1], ['allOf', null]]) {
    if (!Array.isArray(schema[keyword])) continue;
    const errors = schema[keyword].map((item) => schemaError(item, value, path, depth + 1));
    const valid = errors.filter((error) => error === null).length;
    if ((keyword === 'allOf' && valid !== errors.length) || (keyword === 'anyOf' && valid < matchCount) || (keyword === 'oneOf' && valid !== 1)) return `${path} does not match ${keyword}.`;
  }
  const type = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const typeMatches = (candidate) => candidate === 'null' ? value === null
    : candidate === 'object' ? Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      : candidate === 'array' ? Array.isArray(value)
        : candidate === 'integer' ? Number.isSafeInteger(value)
          : candidate === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : candidate === 'string' ? typeof value === 'string'
              : candidate === 'boolean' ? typeof value === 'boolean' : false;
  if (type.length && !type.some(typeMatches)) return `${path} has the wrong type.`;
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short.`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long.`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below the minimum.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} is above the maximum.`;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return `${path} is below the exclusive minimum.`;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return `${path} is above the exclusive maximum.`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} has too few items.`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items.`;
    if (schema.uniqueItems && value.some((item, index) => value.slice(index + 1).some((next) => deepEqual(item, next)))) return `${path} must contain unique items.`;
    if (schema.items) for (let index = 0; index < value.length; index++) {
      const error = schemaError(schema.items, value[index], `${path}[${index}]`, depth + 1);
      if (error) return error;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) return `${path} has too few fields.`;
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) return `${path} has too many fields.`;
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) return `${path} is missing required field ${key}.`;
    for (const [key, item] of Object.entries(value)) {
      const childSchema = properties[key] || (schema.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
      if (!childSchema && schema.additionalProperties === false) return `${path} contains unsupported field ${key}.`;
      if (childSchema) {
        const error = schemaError(childSchema, item, `${path}.${key}`, depth + 1);
        if (error) return error;
      }
    }
  }
  return null;
}

export function validateMcpArguments(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 30000) throw new Error('MCP tool input must be a JSON object smaller than 30 KB.');
  if (!isSupportedInputSchema(schema) || (schema.type && schema.type !== 'object' && !(Array.isArray(schema.type) && schema.type.includes('object')))) throw new Error('Only supported object input schemas can be used for connected MCP tools.');
  const error = schemaError(schema, input);
  if (error) throw new Error(error);
}
