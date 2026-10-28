// Checks tool arguments against the same JSON Schema the tool publishes, so the schema is the one source of truth.
// Supports the subset the tools use: type, enum, const, required, properties, additionalProperties,
// minLength/maxLength, pattern, minimum/maximum, integer, items, minItems/maxItems, uniqueItems, anyOf,
// and propertyNames/minProperties/maxProperties for objects used as maps.

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const matchesType = (v, t) => (t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);

/** Returns a list of problems (empty when valid). Paths read like `weights.alpha` or `criteria[0].weight`. */
export function validate(value, schema, path = "arguments") {
  const problems = [];
  const at = (p) => (path === "arguments" ? p : `${path}${p.startsWith("[") ? "" : "."}${p}`);
  const name = path === "arguments" ? "arguments" : path;

  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(value, s, path).length === 0);
    if (!ok) problems.push(`${name}: ${schema.description ?? "doesn't match any allowed form"}.`);
    return problems;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      problems.push(`${name} must be ${types.join(" or ")}.`);
      return problems;
    }
  }
  if (schema.const !== undefined && value !== schema.const) problems.push(`${name} must be ${JSON.stringify(schema.const)}.`);
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${name} must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}.`);

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${name} must be at least ${schema.minLength} characters.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${name} must be at most ${schema.maxLength} characters.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${name} has characters or a length that isn't allowed (${schema.pattern}).`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${name} must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${name} must be at most ${schema.maximum}.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${name} needs at least ${schema.minItems} item(s).`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${name} allows at most ${schema.maxItems} item(s).`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) problems.push(`${name} items must be unique.`);
    if (schema.items) value.forEach((v, i) => problems.push(...validate(v, schema.items, `${path === "arguments" ? "" : path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const keys = Object.keys(value);
    for (const r of schema.required ?? []) if (!(r in value)) problems.push(`${at(r)} is required.`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) problems.push(`${name} needs at least ${schema.minProperties} entries.`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) problems.push(`${name} allows at most ${schema.maxProperties} entries.`);
    for (const k of keys) {
      if (schema.propertyNames) problems.push(...validate(k, schema.propertyNames, `${at(k)} (name)`));
      if (schema.properties && Object.hasOwn(schema.properties, k)) problems.push(...validate(value[k], schema.properties[k], at(k)));
      else if (schema.additionalProperties === false) problems.push(`${at(k)} isn't a known argument.`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") problems.push(...validate(value[k], schema.additionalProperties, at(k)));
    }
  }
  return problems;
}
