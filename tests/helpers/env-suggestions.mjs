/** Shared collection data for autocomplete hierarchy and real extension workflow checks. */
import {editorFixture} from './extension-storage.mjs'

/** Build a selected local env with nested overrides, an empty override, and unrelated sibling variables. */
export function suggestionsCollection() {
  const editor = {...editorFixture(), name: 'Get item', url: 'https://example.test/items', authType: 'bearer'}
  return {
    id: 'shop', name: 'Shop', chosenEnv: 'local',
    env: {
      baseNames: ['baseUrl', 'token', 'shared', 'unfilled'],
      forks: [
        {id: 'collection-local', name: 'local', variables: [
          {name: 'baseUrl', value: 'https://example.test'}, {name: 'token', value: 'collection-secret'},
          {name: 'shared', value: 'collection-value'}, {name: 'localOnly', value: 'local-value'}
        ]},
        {id: 'collection-prod', name: 'production', variables: [{name: 'prodOnly', value: 'prod-secret'}]}
      ]
    },
    requests: [{
      id: 'outer', name: 'Outer', env: {baseNames: ['outerOnly'], forks: []}, requests: [{
        id: 'items', name: 'Items',
        env: {baseNames: ['shared', 'folderOnly'], forks: [{id: 'folder-local', name: 'local', variables: [
          {name: 'shared', value: 'folder-value'}, {name: 'folderOnly', value: 'folder-secret'}
        ]}]},
        requests: [{
          id: 'get-item', editor,
          env: {baseNames: ['token', 'shared'], forks: [{id: 'api-local', name: 'local', variables: [
            {name: 'token', value: 'api-secret'}, {name: 'shared', value: ''}, {name: 'apiOnly', value: 'api-value'}
          ]}]}
        }]
      }]
    }, {
      id: 'sibling', editor: {...editor, name: 'Other API'},
      env: {baseNames: ['siblingOnly'], forks: []}
    }]
  }
}
