import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComposerAddContent } from '../../src/components/chat/ComposerAddContent';

function render(onOpenFiles?: () => void) {
  return renderToStaticMarkup(createElement(ComposerAddContent, {
    documents: [],
    agents: [],
    uploadedFiles: [],
    projectFiles: [],
    canvasGroups: [],
    skillOptions: [],
    toolOptions: [],
    uploadEnabled: true,
    uploadStatus: '',
    onUploadFiles: vi.fn(),
    onUploadFolder: vi.fn(),
    onOpenFiles,
    onAddUploadedFile: vi.fn(),
    onAddProjectFile: vi.fn(),
    onAddDocument: vi.fn(),
    onAddGroup: vi.fn(),
    onAddAgent: vi.fn(),
    onAddSkill: vi.fn(),
    onAddTool: vi.fn(),
  }));
}

describe('composer add-content actions', () => {
  it('does not render a dead Browse file list row without a handler', () => {
    expect(render()).not.toContain('Browse file list');
  });

  it('renders Browse file list only when the surrounding surface can open it', () => {
    expect(render(vi.fn())).toContain('Browse file list');
  });
});
