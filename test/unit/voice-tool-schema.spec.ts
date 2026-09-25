import { describe, expect, it } from 'vitest'
import { Type, type FunctionDeclaration } from '@google/genai'

import { jsonSchemaFromGemini, openAiToolsFromDeclarations } from '../../server/lib/voice/tool-schema'
import { voiceToolDeclarations } from '../../server/lib/voice/tools'

/**
 * Domo's one set of voice tools, read in OpenAI's dialect.
 *
 * The failure this guards against is silent: a `"type": "OBJECT"` that reaches
 * the Responses API is not answered with a complaint about capitals — the tool
 * is simply never called correctly, which on a voice surface reads as a model
 * that has stopped understanding its own tools. So the whole real declaration
 * list is converted here and swept for anything left in Gemini's spelling.
 */

function types(schema: any, found: string[] = []): string[] {
  if (!schema || typeof schema !== 'object') return found
  if (typeof schema.type === 'string') found.push(schema.type)
  for (const child of Object.values(schema.properties ?? {})) types(child, found)
  if (schema.items) types(schema.items, found)
  return found
}

describe('converting a Gemini schema to JSON Schema', () => {
  it('lowercases the type and keeps the description', () => {
    const schema = jsonSchemaFromGemini({ type: Type.STRING, description: 'an id' })

    expect(schema).toEqual({ type: 'string', description: 'an id' })
  })

  it('walks nested properties, items, enums and required', () => {
    const schema = jsonSchemaFromGemini({
      type: Type.OBJECT,
      properties: {
        delivery: { type: Type.STRING, enum: ['steer', 'queue'] },
        files: { type: Type.ARRAY, items: { type: Type.STRING } },
        nested: { type: Type.OBJECT, properties: { count: { type: Type.INTEGER } } }
      },
      required: ['delivery']
    })

    expect(schema).toEqual({
      type: 'object',
      properties: {
        delivery: { type: 'string', enum: ['steer', 'queue'] },
        files: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { count: { type: 'integer' } } }
      },
      required: ['delivery']
    })
  })

  it('gives a no-argument tool an empty properties object rather than none', () => {
    expect(jsonSchemaFromGemini({ type: Type.OBJECT })).toEqual({ type: 'object', properties: {} })
    // And a declaration with no parameters at all is still an object schema.
    expect(jsonSchemaFromGemini(undefined)).toEqual({ type: 'object', properties: {} })
  })

  it('drops TYPE_UNSPECIFIED instead of passing on a type no validator knows', () => {
    expect(jsonSchemaFromGemini({ type: Type.TYPE_UNSPECIFIED, description: 'anything' }))
      .toEqual({ description: 'anything' })
  })
})

describe('the voice tools as OpenAI function tools', () => {
  const declarations = voiceToolDeclarations({ autoTitle: true })
  const tools = openAiToolsFromDeclarations(declarations)

  it('converts every declaration, keeping its name and description', () => {
    expect(tools).toHaveLength(declarations.length)
    expect(tools.length).toBeGreaterThan(10)
    for (const tool of tools) {
      expect(tool.type).toBe('function')
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.parameters.type).toBe('object')
    }
  })

  it('leaves no Gemini spelling anywhere in the converted schemas', () => {
    const spellings = tools.flatMap(tool => types(tool.parameters))

    expect(spellings.length).toBeGreaterThan(20)
    expect(spellings.filter(type => type !== type.toLowerCase())).toEqual([])
    expect(spellings).not.toContain('type_unspecified')
  })

  it('does not ask for strict mode, which would require every argument', () => {
    // Domo's tools are mostly optional arguments ("the agent, or the most
    // recently active one"), and strict mode demands all of them in `required`.
    expect(tools.every(tool => tool.strict === undefined)).toBe(true)
  })

  it('follows the auto-title switch, exactly as the Gemini declarations do', () => {
    const without = openAiToolsFromDeclarations(voiceToolDeclarations({ autoTitle: false }))

    expect(tools.map(tool => tool.name)).toContain('set_conversation_title')
    expect(without.map(tool => tool.name)).not.toContain('set_conversation_title')
  })

  it('skips a declaration with no name rather than declaring an unnamed tool', () => {
    const nameless = [{ description: 'no name' } as FunctionDeclaration]

    expect(openAiToolsFromDeclarations(nameless)).toEqual([])
  })
})
