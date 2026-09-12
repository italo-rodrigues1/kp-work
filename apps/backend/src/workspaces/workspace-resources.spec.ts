import {
  assertDatabaseName,
  workspaceResourceNames,
} from './workspace-resources';

describe('workspace resource names', () => {
  it('deriva nomes determinísticos, válidos e sem expor o UUID com hífens', () => {
    expect(
      workspaceResourceNames('123e4567-e89b-42d3-a456-426614174000'),
    ).toEqual({
      id: '123e4567-e89b-42d3-a456-426614174000',
      databaseName: 'chat_ai_ws_123e4567e89b42d3a456426614174000',
      uploadBucket: 'chat-ai-ws-123e4567e89b42d3a456426614174000-uploads',
      contextBucket: 'chat-ai-ws-123e4567e89b42d3a456426614174000-contexts',
    });
  });

  it('recusa UUIDs e identificadores arbitrários', () => {
    expect(() => workspaceResourceNames('../shared')).toThrow();
    expect(() =>
      assertDatabaseName('tenant"; DROP DATABASE postgres;'),
    ).toThrow();
  });
});
