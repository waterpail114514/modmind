const id = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }
const skills = { type: 'array', maxItems: 64, uniqueItems: true, items: id }
const instructions = { type: 'string', minLength: 1, maxLength: 32000 }
const loaders = { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: id }
const profile = {
  type: 'object', additionalProperties: false, required: ['instructions', 'skills'],
  properties: {
    instructions, skills,
    greetings: { type: 'array', minItems: 1, maxItems: 60, items: { type: 'string', minLength: 1, maxLength: 160 } },
    starters: { type: 'array', minItems: 1, maxItems: 60, items: {
      type: 'object', additionalProperties: false, required: ['title', 'prompt'],
      properties: { title: { type: 'string', minLength: 1, maxLength: 80 }, prompt: { type: 'string', minLength: 1, maxLength: 2000 } }
    } },
    variants: { type: 'array', maxItems: 16, items: {
      type: 'object', additionalProperties: false, required: ['loaders', 'instructions', 'skills'], properties: { loaders, instructions, skills }
    } }
  }
}
const binding = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: { pluginId: id, action: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9:_-]{0,79}$' }, input: { type: 'object', maxProperties: 64 } }
}
const condition = { type: 'object', maxProperties: 32, additionalProperties: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', maxLength: 160 } } }
const field = {
  type: 'object', additionalProperties: false, required: ['id', 'title', 'type'],
  properties: {
    id, title: { type: 'string', minLength: 1, maxLength: 80 }, type: { enum: ['input', 'options', 'select'] },
    bind: { enum: ['name', 'loader', 'minecraftVersion'] }, default: { type: 'string', maxLength: 2000 },
    required: { type: 'boolean' }, readOnly: { type: 'boolean' }, placeholder: { type: 'string', maxLength: 160 }, maxLength: { type: 'integer', minimum: 1, maximum: 2000 }, when: condition,
    options: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['value', 'title'], properties: { value: { type: 'string', minLength: 1, maxLength: 160 }, title: { type: 'string', minLength: 1, maxLength: 160 }, when: condition } } },
    source: { type: 'object', additionalProperties: false, required: ['kind', 'loaderField'], properties: { kind: { const: 'loader-versions' }, loaderField: id } }
  }
}
export const STUDIO_DEFINITION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['apiVersion', 'id', 'name', 'projectKind', 'loaders', 'defaultTarget', 'templateHandler', 'ai'],
  properties: {
    apiVersion: { const: 1 }, id, projectKind: id,
    name: { type: 'string', minLength: 1, maxLength: 80 }, loaders,
    defaultTarget: { type: 'object', additionalProperties: false, required: ['loader', 'version'], properties: { loader: id, version: { type: 'string', minLength: 1, maxLength: 80 } } },
    templateHandler: id,
    skillAssetGroup: id,
    navigation: { type: 'object', additionalProperties: false, required: ['hideCoreViews'], properties: { hideCoreViews: { type: 'array', maxItems: 1, uniqueItems: true, items: { enum: ['build'] } }, compactSidebar: { type: 'boolean' } } },
    creation: { type: 'object', additionalProperties: false, required: ['fields'], properties: { fields: { type: 'array', minItems: 1, maxItems: 32, items: field } } },
    adoption: { type: 'object', additionalProperties: false, required: ['handler', 'priority', 'markers'], properties: { handler: id, priority: { type: 'integer', minimum: 0, maximum: 100 }, markers: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[a-zA-Z0-9_./-]+$' } } } },
    ai: { type: 'object', additionalProperties: false, required: ['workbench', 'inspiration'], properties: { workbench: profile, inspiration: profile } },
    tasks: { type: 'object', additionalProperties: false, properties: { check: binding, build: binding, test: binding, export: binding } }
  }
}
