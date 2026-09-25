import type { FunctionDeclaration, Schema } from '@google/genai'

/**
 * Domo's voice tools, as the OpenAI Responses backend needs them.
 *
 * There is one set of tool declarations (`./tools.ts`) and there will go on
 * being one: the tools are the same errands whoever is holding the microphone,
 * and a second hand-written copy in OpenAI's dialect would be a list to forget
 * to update. They are written in Gemini's dialect because that is what came
 * first, and the difference is small and mechanical — Gemini's `Schema` is
 * JSON Schema with the `type` in capitals and a handful of its own spellings.
 *
 * Pure, and tested against the real declarations: the failure this guards
 * against is silent. An unconverted `"type": "OBJECT"` is not rejected by the
 * Responses API with a useful message about capitals — the tool simply never
 * gets called correctly, which reads as a model that has stopped understanding
 * its own tools.
 */

/** An OpenAI Responses function tool, as `delegation.responses.tools` takes them. */
export interface OpenAiFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters: JsonSchema
  /**
   * Deliberately absent rather than `false`: strict mode additionally requires
   * every property to be listed in `required`, and Domo's tools are mostly
   * optional arguments ("the agent, or the most recently active one").
   */
  strict?: boolean
}

export interface JsonSchema {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  [key: string]: unknown
}

/** Gemini spells the JSON Schema types in capitals, and adds one of its own. */
const TYPES: Record<string, string> = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  NULL: 'null'
}

export function jsonSchemaFromGemini(schema: Schema | undefined): JsonSchema {
  if (!schema) return { type: 'object', properties: {} }
  const out: JsonSchema = {}

  if (schema.type) {
    const type = String(schema.type)
    // `TYPE_UNSPECIFIED` means "the declaration did not say", and a literal
    // pass-through would be a type no validator knows.
    if (type !== 'TYPE_UNSPECIFIED') out.type = TYPES[type] ?? type.toLowerCase()
  }
  if (schema.description) out.description = schema.description
  if (schema.enum?.length) out.enum = [...schema.enum]
  if (schema.items) out.items = jsonSchemaFromGemini(schema.items)
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [name, jsonSchemaFromGemini(child)])
    )
  }
  if (schema.required?.length) out.required = [...schema.required]

  // An object with no properties at all is how a no-argument tool is written,
  // and the Responses API wants the key present rather than inferred.
  if (out.type === 'object' && !out.properties) out.properties = {}
  return out
}

export function openAiToolsFromDeclarations(declarations: FunctionDeclaration[]): OpenAiFunctionTool[] {
  return declarations
    .filter((declaration): declaration is FunctionDeclaration & { name: string } => !!declaration.name)
    .map(declaration => ({
      type: 'function' as const,
      name: declaration.name,
      ...(declaration.description ? { description: declaration.description } : {}),
      parameters: jsonSchemaFromGemini(declaration.parameters as Schema | undefined)
    }))
}
